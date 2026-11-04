import "server-only";
import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "../env";
import { activePlan, refreshFutureWeeks, restoreVersion } from "../planning/service";
import { buildSnapshot } from "./data";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { isToolName, runTool, TOOL_STATUS, TOOLS, ToolInputError, type CoachAction, type ToolContext } from "./tools";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Item = OpenAI.Responses.ResponseInputItem;

/** Events streamed to the browser, one JSON object per line. */
export type CoachEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "actions"; messageId: string; items: CoachAction[] }
  | { type: "done" }
  | { type: "error"; message: string };

/** Tool-call rounds per athlete message; plenty for look up, change, check, answer. */
const MAX_ROUNDS = 10;

export const coachConfigured = () => Boolean(env.openaiApiKey());

export async function listConversations(db: SupabaseClient, userId: string, limit = 30) {
  const { data } = await db.from("coach_conversations").select("id, title, updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit);
  return (data ?? []) as { id: string; title: string; updated_at: string }[];
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** what the coach changed during this reply */
  actions: CoachAction[];
  /** stored rows holding those actions (for Undo) */
  actionMessageIds: string[];
  undone: boolean;
  createdAt: string;
}

/** The visible transcript: athlete messages, and the coach's text and changes merged across tool rounds. */
export async function loadTranscript(db: SupabaseClient, userId: string, conversationId: string): Promise<ChatTurn[]> {
  const { data } = await db
    .from("coach_messages")
    .select("id, role, kind, display_text, actions, undone_at, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .order("seq");
  const out: ChatTurn[] = [];
  for (const m of data ?? []) {
    if (m.kind === "user") {
      out.push({ id: m.id, role: "user", text: m.display_text ?? "", actions: [], actionMessageIds: [], undone: false, createdAt: m.created_at });
      continue;
    }
    let t = out.at(-1);
    if (t?.role !== "assistant") {
      t = { id: m.id, role: "assistant", text: "", actions: [], actionMessageIds: [], undone: false, createdAt: m.created_at };
      out.push(t);
    }
    if (m.display_text) t.text = t.text ? `${t.text}\n\n${m.display_text}` : m.display_text;
    if (m.actions?.length) {
      t.actions.push(...m.actions);
      t.actionMessageIds.push(m.id);
      if (m.undone_at) t.undone = true;
    }
  }
  return out.filter((t) => t.role === "user" || t.text || t.actions.length);
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

/** Output items as they can be sent back as input next turn. */
const replayable = (items: any[]): Item[] => items.filter((i) => i.type === "message" || i.type === "function_call" || i.type === "reasoning") as Item[];

export interface TurnInput {
  db: SupabaseClient;
  userId: string;
  conversationId: string | null;
  text: string;
  today: string;
  timezone: string;
}

/**
 * Runs one athlete message through the coach and yields events as they
 * happen. Every API item is stored verbatim (append-only), and responses are
 * not stored at OpenAI (store: false, reasoning carried as encrypted content),
 * so the next turn replays exactly what the model saw.
 */
export async function* runCoachTurn(input: TurnInput, client = new OpenAI({ apiKey: env.openaiApiKey()! })): AsyncGenerator<CoachEvent> {
  const { db, userId, today } = input;

  // conversation
  let conv: any;
  if (input.conversationId) {
    const { data } = await db.from("coach_conversations").select("*").eq("id", input.conversationId).eq("user_id", userId).maybeSingle();
    if (!data) throw new Error("Conversation not found");
    conv = data;
  } else {
    const { data, error } = await db
      .from("coach_conversations")
      .insert({ user_id: userId, title: titleFrom(input.text), prompt_version: PROMPT_VERSION, model: env.coachModel() })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    conv = data;
  }
  yield { type: "conversation", id: conv.id, title: conv.title };

  // history (append-only replay). Conversations from another model or provider can't be
  // replayed item by item, so they continue from their visible text only.
  const { data: rows } = await db.from("coach_messages").select("seq, role, kind, content, display_text, snapshot_hash").eq("conversation_id", conv.id).order("seq");
  const history = rows ?? [];
  const sameModel = conv.model === env.coachModel() && conv.prompt_version === PROMPT_VERSION;
  const items: Item[] = sameModel
    ? history.flatMap((r: any) => (Array.isArray(r.content) ? (r.content as Item[]) : []))
    : history
        .filter((r: any) => r.display_text && (r.kind === "user" || r.kind === "assistant"))
        .map((r: any) => ({ role: r.role, content: r.display_text }) as Item);
  let seq = history.length ? history[history.length - 1].seq + 1 : 0;

  const snap = await buildSnapshot(db, userId, today, input.timezone);
  const snapHash = hash(snap.replace(/^Today is .*$/m, ""));
  const lastSnap = sameModel ? ([...history].reverse().find((r: any) => r.snapshot_hash)?.snapshot_hash ?? null) : null;
  const dayChanged = !sameModel || !history.some((r: any) => r.snapshot_hash && JSON.stringify(r.content).includes(`Today is ${today}`));
  const includeSnapshot = snapHash !== lastSnap || dayChanged;
  const userItem: Item = {
    role: "user",
    content: [...(includeSnapshot ? [{ type: "input_text" as const, text: `<athlete_data>\n${snap}\n</athlete_data>` }] : []), { type: "input_text" as const, text: input.text }],
  };
  const store = async (row: Record<string, unknown>) => {
    const { data, error } = await db.from("coach_messages").insert({ conversation_id: conv.id, user_id: userId, seq: seq++, ...row }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  await store({ role: "user", kind: "user", content: [userItem], display_text: input.text, snapshot_hash: includeSnapshot ? snapHash : null });
  items.push(userItem);
  if (!sameModel) await db.from("coach_conversations").update({ prompt_version: PROMPT_VERSION, model: env.coachModel() }).eq("id", conv.id);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const final: OpenAI.Responses.Response = yield* streamOnce(client, items, last, conv.id);
    const output = replayable(final.output as any[]);
    const text = final.output
      .filter((o): o is OpenAI.Responses.ResponseOutputMessage => o.type === "message")
      .flatMap((m) => m.content.map((c) => (c.type === "output_text" ? c.text : c.type === "refusal" ? c.refusal : "")))
      .join("")
      .trim();
    const calls = final.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    await store({ role: "assistant", kind: "assistant", content: output, display_text: text || null, model: final.model, usage: final.usage, stop_reason: final.status });
    items.push(...output);
    if (final.status === "incomplete" && !calls.length) {
      if (!text) yield { type: "text", delta: "Sorry, I lost my train of thought there. Could you ask that again?" };
      break;
    }
    if (!calls.length) break;

    // tools run one after another: later calls may depend on earlier changes
    const ctx: ToolContext = { db, userId, today, actions: [] };
    const results: Item[] = [];
    for (const c of calls) {
      let out: string;
      try {
        out = await runTool(c.name, JSON.parse(c.arguments || "{}"), ctx);
      } catch (e) {
        out = e instanceof ToolInputError || e instanceof SyntaxError ? `Invalid input: ${e.message}` : `The app couldn't do this (${e instanceof Error ? e.message : "unknown error"}).`;
      }
      results.push({ type: "function_call_output", call_id: c.call_id, output: out });
    }
    const id = await store({ role: "user", kind: "tool_results", content: results, actions: ctx.actions });
    items.push(...results);
    if (ctx.actions.length) yield { type: "actions", messageId: id, items: ctx.actions };
  }

  await db.from("coach_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
  yield { type: "done" };
}

/** One streamed request. Yields text deltas and tool status; returns the final response. */
async function* streamOnce(client: OpenAI, input: Item[], finalRound: boolean, conversationId: string): AsyncGenerator<CoachEvent, OpenAI.Responses.Response> {
  const stream = client.responses.stream({
    model: env.coachModel(),
    instructions: SYSTEM_PROMPT,
    input,
    tools: TOOLS,
    // on the last allowed round the coach must answer with what it has
    tool_choice: finalRound ? "none" : "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium" },
    // nothing is kept at OpenAI; reasoning comes back encrypted so it can be replayed
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 16000,
    prompt_cache_key: `loype-coach-${conversationId}`,
  });
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") yield { type: "text", delta: event.delta };
    else if (event.type === "response.output_item.added" && event.item.type === "function_call") {
      const name = event.item.name;
      yield { type: "status", text: isToolName(name) ? TOOL_STATUS[name] : "Looking that up" };
    }
  }
  return (await stream.finalResponse()) as OpenAI.Responses.Response;
}

/**
 * Undoes the plan changes the coach made in one reply: restores the plan
 * version from before the first change (and the settings, if they changed),
 * and removes sessions the coach added. Route and run changes stay.
 */
export async function undoCoachActions(db: SupabaseClient, userId: string, messageIds: string[], today: string): Promise<{ undone: number } | { error: string }> {
  const { data: rows } = await db.from("coach_messages").select("id, actions, undone_at, seq, conversation_id").in("id", messageIds).eq("user_id", userId).order("seq");
  if (!rows?.length) return { error: "Nothing to undo" };
  if (rows.some((r: any) => r.undone_at)) return { error: "Already undone" };
  const actions = rows.flatMap((r: any) => (r.actions ?? []) as CoachAction[]).filter((a) => a.kind === "plan" && a.planId && a.versionBefore != null);
  if (!actions.length) return { error: "No plan changes to undo" };
  const byPlan = new Map<string, CoachAction>();
  for (const a of actions) if (!byPlan.has(a.planId!)) byPlan.set(a.planId!, a);
  for (const [planId, first] of byPlan) {
    const { data: plan } = await db.from("training_plans").select("id, goal_id, user_id").eq("id", planId).eq("user_id", userId).maybeSingle();
    if (!plan) continue;
    const settings = actions.find((a) => a.planId === planId && a.prevConfig);
    if (settings?.prevConfig) await db.from("training_plans").update({ config: settings.prevConfig }).eq("id", planId);
    if (settings?.prevGoal) await db.from("goals").update(settings.prevGoal).eq("id", plan.goal_id).eq("user_id", userId);
    if (settings?.prevConfig) {
      // the settings change rebuilt the weeks ahead, so rebuild them again from the old settings
      const fresh = await activePlan(db, userId);
      if (fresh?.id === planId) await refreshFutureWeeks(db, userId, fresh, today, { force: true, reason: "Undid the coach's settings change: the rest of the plan was recalculated from your previous settings." });
      continue;
    }
    const { data: v } = await db.from("plan_versions").select("snapshot").eq("plan_id", planId).eq("version", first.versionBefore!).maybeSingle();
    if (!v?.snapshot?.workouts?.length) continue;
    // sessions the coach added aren't in the old version: remove them, then restore the rest
    const keep = new Set((v.snapshot.workouts as any[]).map((w) => w.id));
    const { data: now } = await db.from("planned_workouts").select("id, status").eq("plan_id", planId);
    const added = (now ?? []).filter((w: any) => !keep.has(w.id) && w.status === "planned").map((w: any) => w.id);
    if (added.length) await db.from("planned_workouts").delete().in("id", added);
    await restoreVersion(db, userId, planId, first.versionBefore!);
  }
  await db.from("coach_messages").update({ undone_at: new Date().toISOString() }).in("id", rows.map((r: any) => r.id));
  return { undone: actions.length };
}
