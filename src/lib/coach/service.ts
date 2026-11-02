import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "../env";
import { buildSnapshot } from "./data";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { isToolName, runTool, TOOL_STATUS, TOOLS, ToolInputError, type ToolContext } from "./tools";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Block = Anthropic.Beta.BetaContentBlockParam;
type Msg = Anthropic.Beta.BetaMessageParam;

/** Events streamed to the browser, one JSON object per line. */
export type CoachEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "proposal"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Tool-call rounds per athlete message; plenty for a look-up-then-answer turn. */
const MAX_ROUNDS = 8;

export const coachConfigured = () => Boolean(env.anthropicApiKey());

export async function listConversations(db: SupabaseClient, userId: string, limit = 30) {
  const { data } = await db.from("coach_conversations").select("id, title, updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit);
  return (data ?? []) as { id: string; title: string; updated_at: string }[];
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  proposalIds: string[];
  createdAt: string;
}

/** The visible transcript: athlete messages, and the coach's text merged across tool rounds. */
export async function loadTranscript(db: SupabaseClient, userId: string, conversationId: string): Promise<ChatTurn[]> {
  const { data } = await db
    .from("coach_messages")
    .select("id, role, kind, display_text, proposal_ids, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .order("seq");
  const out: ChatTurn[] = [];
  for (const m of data ?? []) {
    if (m.kind === "user") out.push({ id: m.id, role: "user", text: m.display_text ?? "", proposalIds: [], createdAt: m.created_at });
    else {
      const last = out.at(-1);
      const target = last?.role === "assistant" ? last : null;
      if (target) {
        if (m.display_text) target.text = target.text ? `${target.text}\n\n${m.display_text}` : m.display_text;
        target.proposalIds.push(...(m.proposal_ids ?? []));
      } else if (m.kind === "assistant" || m.proposal_ids?.length) {
        out.push({ id: m.id, role: "assistant", text: m.display_text ?? "", proposalIds: [...(m.proposal_ids ?? [])], createdAt: m.created_at });
      }
    }
  }
  return out;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const stripThinking = (content: Block[]) => content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

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
 * happen. Every API message is stored verbatim (append-only), so the next
 * turn replays exactly what the model saw. Fresh data goes in the user turn,
 * never into the system prompt.
 */
export async function* runCoachTurn(input: TurnInput, client = new Anthropic({ apiKey: env.anthropicApiKey()! })): AsyncGenerator<CoachEvent> {
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

  // history (append-only replay)
  const { data: rows } = await db.from("coach_messages").select("seq, role, content, snapshot_hash").eq("conversation_id", conv.id).order("seq");
  const history = rows ?? [];
  // A new prompt version or model can't validate older reasoning blocks: drop them once rather than fail.
  const freshContext = conv.prompt_version === PROMPT_VERSION && conv.model === env.coachModel();
  const messages: Msg[] = history.map((r: any) => ({ role: r.role, content: freshContext ? r.content : stripThinking(r.content) }));
  let seq = history.length ? history[history.length - 1].seq + 1 : 0;

  const snapshot = await buildSnapshot(db, userId, today, input.timezone);
  const snapHash = hash(snapshot.replace(/^Today is .*$/m, ""));
  const lastSnap = [...history].reverse().find((r: any) => r.snapshot_hash)?.snapshot_hash ?? null;
  const dayChanged = !history.length || !history.some((r: any) => r.snapshot_hash && r.content?.[0]?.text?.includes(`Today is ${today}`));
  const includeSnapshot = snapHash !== lastSnap || dayChanged;
  const userContent: Block[] = [
    ...(includeSnapshot ? [{ type: "text" as const, text: `<athlete_data>\n${snapshot}\n</athlete_data>` }] : []),
    { type: "text", text: input.text },
  ];
  const store = async (row: Record<string, unknown>) => {
    const { error } = await db.from("coach_messages").insert({ conversation_id: conv.id, user_id: userId, seq: seq++, ...row });
    if (error) throw new Error(error.message);
  };
  await store({ role: "user", kind: "user", content: userContent, display_text: input.text, snapshot_hash: includeSnapshot ? snapHash : null });
  messages.push({ role: "user", content: userContent });
  if (!freshContext) await db.from("coach_conversations").update({ prompt_version: PROMPT_VERSION, model: env.coachModel() }).eq("id", conv.id);

  const toolCtx: ToolContext = { db, userId, today, conversationId: conv.id, proposals: [] };
  let stripped = !freshContext;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    let final: Anthropic.Beta.BetaMessage;
    try {
      final = yield* streamOnce(client, messages, last);
    } catch (err) {
      // A history the API can no longer validate (e.g. after a model fallback): retry once without reasoning blocks.
      if (err instanceof Anthropic.BadRequestError && !stripped && /signature|thinking/i.test(err.message)) {
        stripped = true;
        for (const m of messages) if (Array.isArray(m.content)) m.content = stripThinking(m.content as Block[]);
        final = yield* streamOnce(client, messages, last);
      } else throw err;
    }

    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const toolUses = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    await store({ role: "assistant", kind: "assistant", content: final.content, display_text: text || null, model: final.model, usage: final.usage, stop_reason: final.stop_reason });
    messages.push({ role: "assistant", content: final.content as Block[] });

    if (final.stop_reason === "refusal") {
      yield { type: "text", delta: "\n\nI can't help with that one. Ask me about your training, plan or runs." };
      break;
    }
    if (final.stop_reason !== "tool_use" || !toolUses.length) break;

    // run tools (in parallel) and send every result back in one message
    const before = toolCtx.proposals.length;
    const results = await Promise.all(
      toolUses.map(async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        try {
          return { type: "tool_result", tool_use_id: t.id, content: await runTool(t.name, t.input, toolCtx) };
        } catch (e) {
          const msg = e instanceof ToolInputError ? `Invalid input: ${e.message}` : `The app couldn't run this (${e instanceof Error ? e.message : "unknown error"}).`;
          return { type: "tool_result", tool_use_id: t.id, content: msg, is_error: true };
        }
      }),
    );
    const newProposals = toolCtx.proposals.slice(before);
    await store({ role: "user", kind: "tool_results", content: results, proposal_ids: newProposals });
    messages.push({ role: "user", content: results });
    for (const id of newProposals) yield { type: "proposal", id };
  }

  await db.from("coach_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
  yield { type: "done" };
}

/** One streamed request. Yields text deltas and tool status; returns the final message. */
async function* streamOnce(client: Anthropic, messages: Msg[], finalRound: boolean): AsyncGenerator<CoachEvent, Anthropic.Beta.BetaMessage> {
  const stream = client.beta.messages.stream({
    model: env.coachModel(),
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: TOOLS,
    // on the last allowed round the coach must answer with what it has
    tool_choice: finalRound ? { type: "none" } : { type: "auto" },
    messages,
    output_config: { effort: "medium" },
    // caches the whole prefix up to the latest message, so tool rounds and follow-ups are cheap
    cache_control: { type: "ephemeral" },
    // if a safety classifier declines, the API retries on a suitable model inside the same call
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", delta: event.delta.text };
    else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      const name = event.content_block.name;
      yield { type: "status", text: isToolName(name) ? TOOL_STATUS[name] : "Looking that up" };
    }
  }
  return await stream.finalMessage();
}

/** Proposal rows for the chat cards. */
export async function loadProposals(db: SupabaseClient, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const { data } = await db.from("adaptation_proposals").select("id, rule, title, explanation, evidence, changes, status, decided_at").in("id", ids).eq("user_id", userId);
  return (data ?? []) as any[];
}
