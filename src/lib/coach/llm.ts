import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { env } from "../env";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The coach's model providers. Claude (Anthropic API) is the primary when
 * ANTHROPIC_API_KEY is set; OpenAI is the fallback, used when there is no
 * Anthropic key or a Claude request fails or is declined.
 *
 * Conversations are stored in whichever provider's format produced each row,
 * so the converters below turn a stored history into either provider's
 * request format. Reasoning (Claude thinking blocks, OpenAI encrypted
 * reasoning) only goes back to the provider that produced it.
 */

export type Provider = "anthropic" | "openai";

export interface CoachClients {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
}

export function coachClients(): CoachClients {
  const a = env.anthropicApiKey();
  const o = env.openaiApiKey();
  return {
    // one retry, so a failing Claude call reaches the OpenAI fallback quickly
    anthropic: a ? new Anthropic({ apiKey: a, maxRetries: 1 }) : null,
    openai: o ? new OpenAI({ apiKey: o }) : null,
  };
}

export const providerOrder = (c: CoachClients): Provider[] => [...(c.anthropic ? (["anthropic"] as const) : []), ...(c.openai ? (["openai"] as const) : [])];

/** The model a conversation is pinned to: Claude when there's an Anthropic key, else the OpenAI model. */
export const primaryModel = (c: CoachClients) => (c.anthropic ? env.claudeModel() : env.coachModel());

export const modelFor = (p: Provider) => (p === "anthropic" ? env.claudeModel() : env.coachModel());

// ---------------------------------------------------------------------------
// Stored history -> request format
// ---------------------------------------------------------------------------

const ANTHROPIC_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);

/** A stored Anthropic message ({ role, content: blocks }), as opposed to an OpenAI Responses item. */
export function isAnthropicMessage(x: any): boolean {
  return (
    !!x &&
    typeof x === "object" &&
    !("type" in x) &&
    (x.role === "user" || x.role === "assistant") &&
    Array.isArray(x.content) &&
    x.content.length > 0 &&
    x.content.every((b: any) => b && ANTHROPIC_BLOCKS.has(b.type))
  );
}

/** Only the fields the Messages API takes back as input (the SDK may add helper fields). */
export function cleanAnthropicBlocks(blocks: any[]): any[] {
  return (blocks ?? []).map((b: any) => {
    switch (b?.type) {
      case "text":
        return { type: "text", text: b.text, ...(b.citations?.length ? { citations: b.citations } : {}) };
      case "thinking":
        return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: b.data };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
      default:
        return b;
    }
  });
}

const toolOutputText = (c: any): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : String(c ?? "");

const parseArgs = (s: string) => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** One stored item (either provider's format) as Anthropic messages. Reasoning from OpenAI is dropped. */
function itemToAnthropic(i: any): Anthropic.Beta.BetaMessageParam[] {
  if (isAnthropicMessage(i)) return [{ role: i.role, content: i.role === "assistant" ? cleanAnthropicBlocks(i.content) : i.content }];
  if (!i || typeof i !== "object") return [];
  if (i.type === "function_call") return [{ role: "assistant", content: [{ type: "tool_use", id: i.call_id, name: i.name, input: parseArgs(i.arguments) }] }];
  if (i.type === "function_call_output") return [{ role: "user", content: [{ type: "tool_result", tool_use_id: i.call_id, content: toolOutputText(i.output) }] }];
  if (i.type === "reasoning") return [];
  const text =
    typeof i.content === "string"
      ? i.content
      : (i.content ?? [])
          .map((c: any) => (c.type === "input_text" || c.type === "output_text" || c.type === "text" ? c.text : c.type === "refusal" ? c.refusal : ""))
          .filter(Boolean)
          .join("\n\n");
  if (!text) return [];
  if (i.role === "assistant") return [{ role: "assistant", content: [{ type: "text", text }] }];
  if (i.role === "user" || i.role === "developer" || i.role === "system") {
    // OpenAI user items keep their parts as separate blocks (snapshot, context, message)
    const parts = Array.isArray(i.content) ? i.content.filter((c: any) => c.type === "input_text" && c.text).map((c: any) => ({ type: "text" as const, text: c.text })) : [{ type: "text" as const, text }];
    return [{ role: "user", content: parts.length ? parts : [{ type: "text", text }] }];
  }
  return [];
}

const blocksOf = (c: unknown): any[] => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? [...c] : []);

/**
 * Makes a message list valid for the Messages API: roles alternate, every
 * tool_use is answered by a tool_result in the next message, and tool_results
 * come first in their message. Only repairs histories that were cut short
 * (a failed turn); a normal history passes through unchanged.
 */
export function normaliseAnthropic(msgs: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const merged: { role: "user" | "assistant"; content: any[] }[] = [];
  for (const m of msgs) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const prev = merged.at(-1);
    if (prev && prev.role === m.role) prev.content.push(...blocksOf(m.content));
    else merged.push({ role: m.role, content: blocksOf(m.content) });
  }
  if (merged[0]?.role === "assistant") merged.unshift({ role: "user", content: [{ type: "text", text: "(earlier conversation)" }] });
  for (let k = 0; k < merged.length; k++) {
    const m = merged[k];
    if (m.role === "user") {
      const prevIds = new Set(k > 0 ? merged[k - 1].content.filter((b) => b.type === "tool_use").map((b) => b.id) : []);
      // results without a matching call can't be sent
      const results = m.content.filter((b) => b.type === "tool_result" && prevIds.has(b.tool_use_id));
      const rest = m.content.filter((b) => b.type !== "tool_result");
      m.content = [...results, ...rest];
      continue;
    }
    const ids: string[] = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;
    let next = merged[k + 1];
    if (!next || next.role !== "user") {
      next = { role: "user", content: [] };
      merged.splice(k + 1, 0, next);
    }
    const answered = new Set(next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id));
    const missing = ids.filter((id) => !answered.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, content: "Not run: the reply was interrupted.", is_error: true }));
    if (missing.length) next.content.unshift(...missing);
  }
  // a user message emptied of stray results still needs content
  return merged.map((m) => (m.content.length ? m : { ...m, content: [{ type: "text", text: "(continue)" }] })) as Anthropic.Beta.BetaMessageParam[];
}

export function toAnthropicMessages(items: any[]): Anthropic.Beta.BetaMessageParam[] {
  return items.flatMap(itemToAnthropic);
}

type Item = OpenAI.Responses.ResponseInputItem;

/**
 * Output items as they can be sent back as input next turn. Only the fields the
 * Responses API accepts as input are kept: the SDK's stream helper adds extras
 * (parsed_arguments, parsed) that the API rejects with a 400 on replay.
 */
export function replayable(items: any[]): Item[] {
  const out: any[] = [];
  for (const i of items ?? []) {
    if (!i || typeof i !== "object") continue;
    if (isAnthropicMessage(i)) {
      out.push(...anthropicToOpenAI(i));
    } else if (i.type === "message" && i.role === "assistant") {
      out.push({
        type: "message",
        id: i.id,
        role: "assistant",
        status: i.status ?? "completed",
        content: (i.content ?? [])
          .filter((c: any) => c.type === "output_text" || c.type === "refusal")
          .map((c: any) => (c.type === "refusal" ? { type: "refusal", refusal: c.refusal } : { type: "output_text", text: c.text, annotations: c.annotations ?? [] })),
      });
    } else if (i.type === "function_call") {
      out.push({ type: "function_call", id: i.id, call_id: i.call_id, name: i.name, arguments: i.arguments, status: i.status ?? "completed" });
    } else if (i.type === "reasoning") {
      out.push({ type: "reasoning", id: i.id, summary: i.summary ?? [], ...(i.encrypted_content ? { encrypted_content: i.encrypted_content } : {}) });
    } else if (i.type === "function_call_output") {
      out.push({ type: "function_call_output", call_id: i.call_id, output: i.output });
    } else if (i.role === "user" || i.role === "developer" || i.role === "system") {
      out.push({ role: i.role, content: i.content });
    }
  }
  return out as Item[];
}

/** A stored Claude message as Responses API input items. Thinking is dropped. */
function anthropicToOpenAI(m: any): any[] {
  const out: any[] = [];
  if (m.role === "user") {
    for (const b of m.content) if (b.type === "tool_result") out.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolOutputText(b.content) });
    const parts = m.content.filter((b: any) => b.type === "text" && b.text).map((b: any) => ({ type: "input_text", text: b.text }));
    if (parts.length) out.push({ role: "user", content: parts });
    return out;
  }
  for (const b of m.content) {
    if (b.type === "text" && b.text) out.push({ role: "assistant", content: b.text });
    else if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
  }
  return out;
}

/** Every function_call needs an output before the next request: add one for calls a failed turn left open. */
export function normaliseOpenAI(items: Item[]): Item[] {
  const answered = new Set(items.filter((i: any) => i.type === "function_call_output").map((i: any) => i.call_id));
  const out: Item[] = [];
  for (const i of items as any[]) {
    out.push(i);
    if (i.type === "function_call" && !answered.has(i.call_id)) {
      out.push({ type: "function_call_output", call_id: i.call_id, output: "Not run: the reply was interrupted." } as Item);
      answered.add(i.call_id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One-shot text (the run check-in), with fallback
// ---------------------------------------------------------------------------

export interface TextResult {
  text: string;
  model: string;
}

/** Text from a Responses API result. */
export function openAIText(res: { output_text?: string | null; output?: any[] }): string {
  return (
    res.output_text ??
    (res.output ?? [])
      .filter((o: any) => o?.type === "message")
      .flatMap((m: any) => (m.content ?? []).map((c: any) => (c.type === "output_text" ? c.text : "")))
      .join("")
  );
}

/**
 * A short piece of text from `system` + `input`: Claude first, OpenAI if Claude
 * fails, declines or returns nothing. Throws the last error when every provider failed.
 */
export async function generateText(clients: CoachClients, system: string, input: string): Promise<TextResult | null> {
  let lastErr: unknown = null;
  for (const p of providerOrder(clients)) {
    try {
      if (p === "anthropic") {
        const res = await clients.anthropic!.messages.create({
          model: env.claudeModel(),
          max_tokens: 4000,
          system,
          messages: [{ role: "user", content: input }],
          output_config: { effort: "medium" },
        });
        if (res.stop_reason === "refusal") continue;
        const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        if (text.trim()) return { text, model: res.model };
      } else {
        const res = await clients.openai!.responses.create({
          model: env.coachModel(),
          instructions: system,
          input,
          reasoning: { effort: "medium" },
          store: false,
          max_output_tokens: 4000,
        });
        const text = openAIText(res as any);
        if (text.trim()) return { text, model: env.coachModel() };
      }
    } catch (e) {
      lastErr = e;
      console.warn(`coach ${p} request failed${p === "anthropic" && clients.openai ? ", falling back to OpenAI" : ""}:`, e instanceof Error ? e.message : e);
    }
  }
  if (lastErr) throw lastErr;
  return null;
}
