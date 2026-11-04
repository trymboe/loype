"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Link2 } from "lucide-react";
import clsx from "clsx";
import { CardHeader } from "@/components/ui";
import { linkWorkoutAction } from "@/app/(app)/routes/actions";

export interface WorkoutOption {
  id: string;
  label: string;
  sub: string;
  linkedHere: boolean;
  linkedElsewhere: boolean;
}

/** Pick upcoming planned workouts to run on this route. */
export function LinkWorkout({ routeId, workouts }: { routeId: string; workouts: WorkoutOption[] }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = workouts.filter((w) => w.linkedHere);
  const shown = open ? workouts : linked;

  return (
    <section className="card p-5">
      <CardHeader
        title="Planned workouts"
        aside={
          workouts.length > 0 && (
            <button type="button" className="font-semibold text-accent" onClick={() => setOpen((o) => !o)}>
              {open ? "Done" : linked.length ? "Change" : "Link a workout"}
            </button>
          )
        }
      />
      {workouts.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          No upcoming workouts in your plan. <Link href="/plan" className="font-semibold text-accent">Open the plan</Link>
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Link this route to an upcoming session so it shows up on the workout.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {shown.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                disabled={pending || !open}
                onClick={() =>
                  start(async () => {
                    const res = await linkWorkoutAction(routeId, w.id, !w.linkedHere);
                    setError(res.error ?? null);
                  })
                }
                className={clsx(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                  w.linkedHere ? "bg-accent/10" : "bg-surface-2/60",
                  open && "hover:bg-surface-2",
                )}
              >
                <span className={clsx("flex size-6 shrink-0 items-center justify-center rounded-full", w.linkedHere ? "bg-accent text-accent-fg" : "bg-surface-3 text-muted")}>
                  {w.linkedHere ? <Check size={14} /> : <Link2 size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{w.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {w.sub}
                    {w.linkedElsewhere && " · has another route"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
