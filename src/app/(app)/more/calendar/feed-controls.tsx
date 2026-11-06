"use client";

import { useActionState, useState } from "react";
import { Check, Copy } from "lucide-react";
import { setFeedTimeAction, type TimeState } from "./actions";

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="input min-w-0 flex-1 font-mono text-xs" aria-label="Calendar feed URL" />
      <button
        type="button"
        className="btn btn-secondary shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // clipboard blocked: the field is selectable instead
          }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function TimeForm({ startTime }: { startTime: string | null }) {
  const [state, action, pending] = useActionState<TimeState, FormData>(setFeedTimeAction, {});
  const [mode, setMode] = useState(startTime ? "timed" : "allday");
  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {[
          { v: "allday", label: "All-day events" },
          { v: "timed", label: "At a set time" },
        ].map((o) => (
          <label
            key={o.v}
            className={`cursor-pointer rounded-xl px-3 py-2.5 text-center text-sm font-semibold transition-colors ${mode === o.v ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"}`}
          >
            <input type="radio" name="mode" value={o.v} checked={mode === o.v} onChange={() => setMode(o.v)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
      {mode === "timed" && (
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">Usual start time</span>
          <input name="time" type="time" defaultValue={startTime ?? "07:00"} className="input" />
        </label>
      )}
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">Saved</p>}
      <button disabled={pending} className="btn btn-secondary btn-block">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
