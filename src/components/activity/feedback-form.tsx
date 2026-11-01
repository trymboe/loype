"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { saveFeedback } from "@/app/(app)/activities/[id]/actions";

const RPE_LABELS: Record<number, string> = {
  1: "Very easy", 2: "Easy", 3: "Easy", 4: "Comfortable", 5: "Moderate",
  6: "Moderately hard", 7: "Hard", 8: "Very hard", 9: "Extremely hard", 10: "Max effort",
};

export function FeedbackForm({ activityId, initial }: { activityId: string; initial?: { rpe: number | null; legs: string | null; notes: string | null } | null }) {
  const [rpe, setRpe] = useState<number | null>(initial?.rpe ?? null);
  const [legs, setLegs] = useState<string | null>(initial?.legs ?? null);
  const [more, setMore] = useState(Boolean(initial?.notes));
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
        <h2 className="label">How hard did that feel?</h2>
        {saved && !pending && <span className="text-xs font-semibold text-accent">Saved</span>}
      </div>
      <div className="mt-3 grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => {
              setRpe(v);
              setSaved(false);
            }}
            className={clsx(
              "tabular aspect-square rounded-lg text-sm font-semibold transition-colors",
              rpe === v ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <p className="mt-2 h-4 text-xs text-muted">{rpe ? RPE_LABELS[rpe] : "RPE 1–10"}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {["fresh", "normal", "heavy", "sore"].map((l) => (
          <button
            type="button"
            key={l}
            onClick={() => {
              setLegs(legs === l ? null : l);
              setSaved(false);
            }}
            className={clsx("rounded-full px-3 py-1 text-xs capitalize", legs === l ? "bg-fg text-bg" : "bg-surface-2 text-muted")}
          >
            {l} legs
          </button>
        ))}
        {!more && (
          <button type="button" onClick={() => setMore(true)} className="rounded-full px-3 py-1 text-xs text-accent">
            + note
          </button>
        )}
      </div>
      {more && (
        <div className="mt-3 space-y-2">
          <input name="discomfort" placeholder="Any unusual discomfort?" className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent" />
          <textarea name="notes" defaultValue={initial?.notes ?? ""} rows={2} placeholder="Notes" className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent" />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-hr">{error}</p>}
      <button disabled={!rpe || pending || saved} className="mt-4 w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-accent-fg disabled:opacity-40">
        {pending ? "Saving…" : saved ? "Check-in saved" : "Save check-in"}
      </button>
    </form>
  );
}
