import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "../env";
import { activePlan, refreshFutureWeeks, restoreVersion, undoPlanRestart } from "../planning/service";
import { buildSnapshot } from "./data";
import { cleanAnthropicBlocks, coachClients, normaliseAnthropic, normaliseOpenAI, primaryModel, providerOrder, replayable, toAnthropicMessages, type CoachClients, type Provider } from "./llm";
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
const MAX_ROUNDS = 16;

export const coachConfigured = () => Boolean(env.anthropicApiKey() || env.openaiApiKey());

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

/**
 * Whether a reply is still being written in this conversation. A turn stamps
 * the conversation's updated_at when it finishes, so a stored message newer
 * than that stamp belongs to a turn that hasn't finished (or was cut short).
 */
export async function turnInProgress(db: SupabaseClient, userId: string, conversationId: string): Promise<boolean> {
  const [{ data: conv }, { data: last }] = await Promise.all([
    db.from("coach_conversations").select("updated_at").eq("id", conversationId).eq("user_id", userId).maybeSingle(),
    db.from("coach_messages").select("created_at").eq("conversation_id", conversationId).eq("user_id", userId).order("seq", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!conv || !last) return false;
  return new Date(last.created_at).getTime() > new Date(conv.updated_at).getTime();
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

export { replayable } from "./llm";

export interface TurnInput {
  db: SupabaseClient;
  userId: string;
  conversationId: string | null;
  text: string;
  today: string;
  timezone: string;
  /** what the athlete opened the chat from, e.g. a run's check-in; sent with this message only */
  context?: string | null;
}

/** One model response, the same shape whichever provider produced it. */
interface RoundResult {
  /** what to store and replay, in the provider's own format */
  content: any[];
  text: string;
  calls: { id: string; name: string; input: unknown }[];
  model: string;
  usage: unknown;
  stopReason: string | null;
  /** cut off (output limit) with nothing left to run */
  incomplete: boolean;
  /** declined by the provider's safety checks */
  refused: boolean;
}

/** Anthropic tool definitions, from the same schemas the OpenAI tools use. */
const CLAUDE_TOOLS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }));

/**
 * Runs one athlete message through the coach and yields events as they
 * happen. Every API item is stored verbatim (append-only), so the next turn
 * replays exactly what the model saw. Claude is used when ANTHROPIC_API_KEY is
 * set; if a Claude request fails (or is declined) before any text reached the
 * athlete, the rest of the turn runs on OpenAI.
 */
export async function* runCoachTurn(input: TurnInput, clients: CoachClients = coachClients()): AsyncGenerator<CoachEvent> {
  const { db, userId, today } = input;
  const order = providerOrder(clients);
  if (!order.length) throw new Error("The coach has no API key");
  const pinned = primaryModel(clients);

  // conversation
  let conv: any;
  if (input.conversationId) {
    const { data } = await db.from("coach_conversations").select("*").eq("id", input.conversationId).eq("user_id", userId).maybeSingle();
    if (!data) throw new Error("Conversation not found");
    conv = data;
  } else {
    const { data, error } = await db
      .from("coach_conversations")
      .insert({ user_id: userId, title: titleFrom(input.text), prompt_version: PROMPT_VERSION, model: pinned })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    conv = data;
  }
  yield { type: "conversation", id: conv.id, title: conv.title };

  // history (append-only replay). Conversations from another model or prompt version
  // can't be replayed item by item, so they continue from their visible text only.
  const { data: rows } = await db.from("coach_messages").select("seq, role, kind, content, display_text, snapshot_hash").eq("conversation_id", conv.id).order("seq");
  const history = rows ?? [];
  const sameModel = conv.model === pinned && conv.prompt_version === PROMPT_VERSION;
  /** stored items in replay order: verbatim rows, or plain text for an old conversation */
  const stored: any[] = sameModel
    ? history.flatMap((r: any) => (Array.isArray(r.content) ? r.content : []))
    : history.filter((r: any) => r.display_text && (r.kind === "user" || r.kind === "assistant")).map((r: any) => ({ role: r.role, content: r.display_text }));
  let seq = history.length ? history[history.length - 1].seq + 1 : 0;

  const snap = await buildSnapshot(db, userId, today, input.timezone);
  const snapHash = hash(snap.replace(/^Today is .*$/m, ""));
  const lastSnap = sameModel ? ([...history].reverse().find((r: any) => r.snapshot_hash)?.snapshot_hash ?? null) : null;
  const dayChanged = !sameModel || !history.some((r: any) => r.snapshot_hash && JSON.stringify(r.content).includes(`Today is ${today}`));
  const includeSnapshot = snapHash !== lastSnap || dayChanged;
  const parts = [
    ...(includeSnapshot ? [`<athlete_data>\n${snap}\n</athlete_data>`] : []),
    ...(input.context ? [`<run_context>\n${input.context}\n</run_context>`] : []),
    input.text,
  ];
  let provider: Provider = order[0];
  const userItem =
    provider === "anthropic"
      ? { role: "user", content: parts.map((text) => ({ type: "text", text })) }
      : ({ role: "user", content: parts.map((text) => ({ type: "input_text" as const, text })) } satisfies Item);
  const store = async (row: Record<string, unknown>) => {
    const { data, error } = await db.from("coach_messages").insert({ conversation_id: conv.id, user_id: userId, seq: seq++, ...row }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  await store({ role: "user", kind: "user", content: [userItem], display_text: input.text, snapshot_hash: includeSnapshot ? snapHash : null });
  stored.push(userItem);
  if (!sameModel) await db.from("coach_conversations").update({ prompt_version: PROMPT_VERSION, model: pinned }).eq("id", conv.id);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    let final: RoundResult | null = null;
    // try the current provider; before any text reached the athlete, a failure or decline moves to the next one
    while (!final) {
      let emitted = false;
      try {
        const gen = provider === "anthropic" ? claudeRound(clients.anthropic!, stored, last) : openaiRound(clients.openai!, stored, last, conv.id);
        let step = await gen.next();
        while (!step.done) {
          if (step.value.type === "text") emitted = true;
          yield step.value;
          step = await gen.next();
        }
        final = step.value;
        if (final.refused && !emitted && !final.calls.length && nextProvider(order, provider)) {
          console.warn(`coach: ${provider} declined the request, falling back`);
          provider = nextProvider(order, provider)!;
          final = null;
        }
      } catch (err) {
        const next = nextProvider(order, provider);
        if (emitted || !next) throw err;
        console.warn(`coach: ${provider} request failed, falling back to ${next}:`, err instanceof Error ? err.message : err);
        provider = next;
      }
    }

    await store({ role: "assistant", kind: "assistant", content: final.content, display_text: final.text || null, model: final.model, usage: final.usage, stop_reason: final.stopReason });
    stored.push(...final.content);
    // cut off or declined: a half-written tool call isn't run
    if (final.incomplete || final.refused) {
      if (!final.text) yield { type: "text", delta: "Sorry, I lost my train of thought there. Could you ask that again?" };
      break;
    }
    if (!final.calls.length) break;

    // tools run one after another: later calls may depend on earlier changes
    const ctx: ToolContext = { db, userId, today, actions: [] };
    const outputs: { id: string; out: string; error: boolean }[] = [];
    for (const c of final.calls) {
      let out: string;
      let error = false;
      try {
        out = await runTool(c.name, typeof c.input === "string" ? JSON.parse(c.input || "{}") : c.input, ctx);
      } catch (e) {
        error = true;
        out = e instanceof ToolInputError || e instanceof SyntaxError ? `Invalid input: ${e.message}` : `The app couldn't do this (${e instanceof Error ? e.message : "unknown error"}).`;
      }
      outputs.push({ id: c.id, out, error });
    }
    const results: any[] =
      provider === "anthropic"
        ? [{ role: "user", content: outputs.map((o) => ({ type: "tool_result", tool_use_id: o.id, content: o.out, ...(o.error ? { is_error: true } : {}) })) }]
        : outputs.map((o) => ({ type: "function_call_output", call_id: o.id, output: o.out }));
    const id = await store({ role: "user", kind: "tool_results", content: results, actions: ctx.actions });
    stored.push(...results);
    if (ctx.actions.length) yield { type: "actions", messageId: id, items: ctx.actions };
  }

  await db.from("coach_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
  yield { type: "done" };
}

const nextProvider = (order: Provider[], p: Provider): Provider | null => order[order.indexOf(p) + 1] ?? null;

/** One streamed Claude request. Yields text deltas and tool status. */
async function* claudeRound(client: Anthropic, stored: any[], finalRound: boolean): AsyncGenerator<CoachEvent, RoundResult> {
  const stream = client.beta.messages.stream({
    model: env.claudeModel(),
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: normaliseAnthropic(toAnthropicMessages(stored)),
    tools: CLAUDE_TOOLS,
    // on the last allowed round the coach must answer with what it has
    tool_choice: { type: finalRound ? "none" : "auto" },
    // thinking blocks are replayed verbatim; if a stored block no longer matches its
    // conversation (e.g. after a failed turn was repaired), drop it instead of failing
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "high" },
    // caches the system prompt, tools and history up to the newest message
    cache_control: { type: "ephemeral" },
    betas: ["thinking-binding-controls-2026-08-01"],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", delta: event.delta.text };
    else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      const name = event.content_block.name;
      yield { type: "status", text: isToolName(name) ? TOOL_STATUS[name] : "Looking that up" };
    }
  }
  const msg = await stream.finalMessage();
  const content = cleanAnthropicBlocks(msg.content as any[]);
  return {
    content: [{ role: "assistant", content }],
    text: content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim(),
    calls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
    model: msg.model,
    usage: msg.usage,
    stopReason: msg.stop_reason,
    incomplete: msg.stop_reason === "max_tokens",
    refused: msg.stop_reason === "refusal",
  };
}

/** One streamed OpenAI request. Yields text deltas and tool status. */
async function* openaiRound(client: OpenAI, stored: any[], finalRound: boolean, conversationId: string): AsyncGenerator<CoachEvent, RoundResult> {
  const stream = client.responses.stream({
    model: env.coachModel(),
    instructions: SYSTEM_PROMPT,
    input: normaliseOpenAI(replayable(stored)),
    tools: TOOLS,
    // on the last allowed round the coach must answer with what it has
    tool_choice: finalRound ? "none" : "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    // nothing is kept at OpenAI; reasoning comes back encrypted so it can be replayed
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 32000,
    prompt_cache_key: `loype-coach-${conversationId}`,
  });
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") yield { type: "text", delta: event.delta };
    else if (event.type === "response.output_item.added" && event.item.type === "function_call") {
      const name = event.item.name;
      yield { type: "status", text: isToolName(name) ? TOOL_STATUS[name] : "Looking that up" };
    }
  }
  const final = (await stream.finalResponse()) as OpenAI.Responses.Response;
  const text = final.output
    .filter((o): o is OpenAI.Responses.ResponseOutputMessage => o.type === "message")
    .flatMap((m) => m.content.map((c) => (c.type === "output_text" ? c.text : c.type === "refusal" ? c.refusal : "")))
    .join("")
    .trim();
  const calls = final.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
  return {
    content: replayable(final.output as any[]),
    text,
    calls: calls.map((c) => ({ id: c.call_id, name: c.name, input: c.arguments })),
    model: final.model,
    usage: final.usage,
    stopReason: final.status ?? null,
    // complete function calls in a cut-off response still run, as before
    incomplete: final.status === "incomplete" && !calls.length,
    refused: false,
  };
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
    // a moved start replaced the plan's weeks and workouts: put those back first
    for (const a of actions) if (a.planId === planId && a.restart) await undoPlanRestart(db, planId, a.restart);
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
