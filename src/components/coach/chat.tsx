"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import clsx from "clsx";
import { Markdown } from "./markdown";
import { ChangesCard, type Change } from "./changes-card";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions: Change[];
  actionMessageIds: string[];
  undone: boolean;
}

type Event =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "actions"; messageId: string; items: Change[] }
  | { type: "done" }
  | { type: "error"; message: string };

export function CoachChat({
  conversationId: initialId,
  turns: initialTurns,
  suggestions,
}: {
  conversationId: string | null;
  turns: Turn[];
  suggestions: string[];
}) {
  const [conversationId, setConversationId] = useState(initialId);
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: turns.length > 2 ? "smooth" : "auto" });
  }, [turns, status]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    setStatus("Reading your training");
    const reply: Turn = { id: `a-${Date.now()}`, role: "assistant", text: "", actions: [], actionMessageIds: [], undone: false };
    setTurns((t) => [...t, { id: `u-${Date.now()}`, role: "user", text: q, actions: [], actionMessageIds: [], undone: false }, reply]);
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === reply.id ? fn(t) : t)));
    let afterStatus = false;
    let newId: string | null = null;
    try {
      const res = await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, text: q }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `The coach couldn't answer (HTTP ${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as Event;
          if (e.type === "conversation") {
            newId = conversationId ? null : e.id;
            setConversationId(e.id);
          } else if (e.type === "text") {
            setStatus(null);
            const sep = afterStatus;
            afterStatus = false;
            update((t) => ({ ...t, text: sep && t.text && !t.text.endsWith("\n") ? `${t.text}\n\n${e.delta}` : t.text + e.delta }));
          } else if (e.type === "status") {
            setStatus(e.text);
            afterStatus = true;
          } else if (e.type === "actions") {
            update((t) => ({ ...t, actions: [...t.actions, ...e.items], actionMessageIds: [...t.actionMessageIds, e.messageId] }));
          } else if (e.type === "error") setError(e.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The coach couldn't answer.");
    } finally {
      setBusy(false);
      setStatus(null);
      setTurns((ts) => ts.filter((t) => t.role === "user" || t.text || t.actions.length));
      inputRef.current?.focus();
      // only now: updating the URL re-renders the page from the stored conversation
      if (newId) window.history.replaceState(null, "", `/coach?c=${newId}`);
    }
  }

  const empty = turns.length === 0;

  return (
    <div className="flex flex-col">
      {empty && (
        <div className="rise card p-5">
          <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-accent/12 text-accent">
            <Sparkles size={19} />
          </div>
          <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Ask about your training</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Your coach knows your runs, fitness, plan and routes. Ask anything, or tell it what you need: it changes your plan for you, warns you when something looks risky, and every change can be undone.
          </p>
          <div className="stagger mt-4 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} type="button" className="chip text-left" onClick={() => send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <ol className="space-y-5" aria-live="polite">
        {turns.map((t) =>
          t.role === "user" ? (
            <li key={t.id} className="rise flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-[1.25rem] rounded-br-md bg-fg px-4 py-2.5 text-[0.9375rem] leading-relaxed text-bg">{t.text}</p>
            </li>
          ) : (
            <li key={t.id} className="space-y-3">
              {t.text && (
                <div className="text-[0.9375rem] leading-relaxed text-fg-2">
                  <Markdown text={t.text} />
                </div>
              )}
              {t.actions.length > 0 && <ChangesCard changes={t.actions} messageIds={t.actionMessageIds} undone={t.undone} busy={busy && t === turns.at(-1)} />}
            </li>
          ),
        )}
      </ol>

      {status && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
          {status}…
        </p>
      )}
      {error && <p className="mt-4 rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{error}</p>}
      <div ref={endRef} className="h-4" />

      <form
        className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] mt-2 md:bottom-6"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-[1.5rem] border border-[var(--hairline)] bg-surface p-1.5 pl-4 shadow-[var(--shadow-pop)]">
          <label htmlFor="coach-input" className="sr-only">
            Message the coach
          </label>
          <textarea
            id="coach-input"
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
            placeholder={empty ? "Ask your coach…" : "Reply…"}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 text-[0.9375rem] leading-snug outline-none placeholder:text-subtle"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className={clsx("flex size-10 shrink-0 items-center justify-center rounded-full transition", busy || !draft.trim() ? "bg-surface-3 text-subtle" : "bg-accent text-accent-fg")}
          >
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
}
