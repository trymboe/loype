"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { saveFeedback } from "@/app/(app)/activities/[id]/actions";

const RPE_LABELS: Record<number, string> = {
  1: "Very easy", 2: "Easy", 3: "Easy", 4: "Comfortable", 5: "Moderate",
  6: "Moderately hard", 7: "Hard", 8: "Very hard", 9: "Extremely hard", 10: "Max effort",
};

export function FeedbackForm({ activityId, initial }: { activityId: string; initial?: { rpe: number | null; legs: string | null; notes: string | null; discomfort?: string | null } | null }) {
  const [rpe, setRpe] = useState<number | null>(initial?.rpe ?? null);
  const [legs, setLegs] = useState<string | null>(initial?.legs ?? null);
  const [more, setMore] = useState(Boolean(initial?.notes || initial?.discomfort));
  const [saved, setSaved] = useState(Boolean(initial?.rpe));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (form: FormData) =>
    start(async () => {
      setError(null);
      try {
        await saveFeedback(form);
        setSaved(true);
      } catch {
        setError("Couldn't save. Try again.");
      }
    });

  return (
    <form action={submit} className="card p-5">
      <input type="hidden" name="activityId" value={activityId} />
      <input type="hidden" name="rpe" value={rpe ?? ""} />
      <input type="hidden" name="legs" value={legs ?? ""} />
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">How hard did that feel?</h2>
        {saved && !pending && <span className="text-xs font-semibold text-good">Saved</span>}
      </div>
      <div className="mt-4 grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => {
              setRpe(v);
              setSaved(false);
            }}
            className={clsx(
              "tabular aspect-square rounded-[0.625rem] text-sm font-semibold transition-all active:scale-95",
              rpe === v ? "bg-accent text-accent-fg shadow-[0_4px_14px_-4px_var(--accent)]" : rpe != null && v < rpe ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="mt-2 flex h-4 justify-between text-xs text-muted">
        <span className={rpe ? "font-medium text-fg-2" : undefined}>{rpe ? `${rpe} · ${RPE_LABELS[rpe]}` : "Easy"}</span>
        {!rpe && <span>Max effort</span>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {["fresh", "normal", "heavy", "sore"].map((l) => (
          <button
            type="button"
            key={l}
            onClick={() => {
              setLegs(legs === l ? null : l);
              setSaved(false);
            }}
            aria-pressed={legs === l}
            className="chip capitalize"
          >
            {l} legs
          </button>
        ))}
        {!more && (
          <button type="button" onClick={() => setMore(true)} className="chip bg-transparent font-semibold text-accent">
            + Add note
          </button>
        )}
      </div>
      {more && (
        <div className="mt-3 space-y-2">
          <input name="discomfort" defaultValue={initial?.discomfort ?? ""} onChange={() => setSaved(false)} maxLength={500} placeholder="Any unusual discomfort?" className="input" />
          <textarea name="notes" defaultValue={initial?.notes ?? ""} onChange={() => setSaved(false)} maxLength={2000} rows={2} placeholder="Notes" className="input" />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <button disabled={!rpe || pending || saved} className="btn btn-primary btn-block mt-5">
        {pending ? "Saving…" : saved ? "Check-in saved" : "Save check-in"}
      </button>
    </form>
  );
}
