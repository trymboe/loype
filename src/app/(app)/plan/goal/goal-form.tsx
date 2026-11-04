"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import { deletePlanAction, updateGoalAction, type GoalEditState } from "../actions";
import { DAYS } from "../goal-options";
import { Field, Toggle } from "../plan-form";

export interface GoalFormInitial {
  name: string;
  targetTime: string;
  targetWeeklyKm: string;
  runDays: number[];
  longRunDay: number;
  maxWeeklyHours: string;
  includeIntervals: boolean;
  includeLongRuns: boolean;
  includeStrides: boolean;
}

const RACE = ["5k", "10k", "half", "marathon", "race"];

export function GoalForm({ kind, initial }: { kind: string; initial: GoalFormInitial }) {
  const [state, action, pending] = useActionState<GoalEditState, FormData>(updateGoalAction, {});
  const [runDays, setRunDays] = useState<number[]>(initial.runDays);

  return (
    <form action={action} className="space-y-7">
      {(RACE.includes(kind) || kind === "volume") && (
        <section className="space-y-3">
          <h2 className="section-title">Target</h2>
          <div className="grid grid-cols-2 gap-3">
            {kind === "race" && (
              <Field label="Race name">
                <input name="name" defaultValue={initial.name} className="input" placeholder="e.g. Oslo 15K" />
              </Field>
            )}
            {RACE.includes(kind) && (
              <Field label="Target time" hint="Optional, h:mm:ss or mm:ss">
                <input name="target_time" defaultValue={initial.targetTime} className="input" placeholder="h:mm:ss" />
              </Field>
            )}
            {kind === "volume" && (
              <Field label="Weekly distance to build to" hint="Optional">
                <input name="target_weekly_km" defaultValue={initial.targetWeeklyKm} inputMode="decimal" className="input" placeholder="km per week" />
              </Field>
            )}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="section-title">Which days could you run?</h2>
        <div className="grid grid-cols-7 gap-1.5">
          {DAYS.map((d, i) => (
            <label
              key={d}
              className={clsx(
                "cursor-pointer rounded-xl py-2.5 text-center text-xs font-semibold transition-colors",
                runDays.includes(i) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
              )}
            >
              <input
                type="checkbox"
                name="run_days"
                value={i}
                checked={runDays.includes(i)}
                onChange={(e) => setRunDays((r) => (e.target.checked ? [...r, i].sort() : r.filter((x) => x !== i)))}
                className="sr-only"
              />
              {d}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Long run day">
            <select name="long_run_day" defaultValue={initial.longRunDay} className="input">
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max hours per week" hint="Optional">
            <input name="max_weekly_hours" defaultValue={initial.maxWeeklyHours} inputMode="decimal" className="input" placeholder="e.g. 5" />
          </Field>
        </div>
      </section>

      <section className="divide-hairline overflow-hidden rounded-2xl bg-surface-2 text-[0.9375rem]">
        <Toggle name="intervals" label="Include interval sessions" defaultChecked={initial.includeIntervals} />
        <Toggle name="long_runs" label="Include long runs" defaultChecked={initial.includeLongRuns} />
        <Toggle name="strides" label="Include strides on easy days" defaultChecked={initial.includeStrides} />
      </section>

      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
        Saving keeps every planned workout as it is. Day and session settings are used from the next weekly update, which only recalculates weeks that haven&apos;t started.
      </p>

      {state.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{state.error}</p>}
      {state.saved && !pending && <p className="rounded-xl bg-accent/10 p-3 text-sm">{state.saved}</p>}
      <button disabled={pending} className="btn btn-primary btn-block min-h-12">
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

export function DeletePlan() {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <div className="space-y-3">
      <div>
        <h2 className="section-title">Start over</h2>
        <p className="mt-1 text-sm text-muted">To change the goal type or race date, delete this plan and make a new one. The plan, its workouts and its history are removed. Your runs are kept.</p>
      </div>
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="btn btn-secondary btn-block text-danger">
          Delete plan
        </button>
      ) : (
        <form action={deletePlanAction} onSubmit={() => setPending(true)} className="space-y-2 rounded-2xl bg-danger/10 p-3">
          <p className="text-sm font-semibold text-danger">Delete this plan for good? This can&apos;t be undone.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="btn btn-secondary">
              Cancel
            </button>
            <button disabled={pending} className="btn bg-danger text-white">
              {pending ? "Deleting…" : "Yes, delete"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
