"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import { createPlanAction, type PlanFormState } from "./actions";

const input = "w-full rounded-xl border border-border bg-surface-2 px-4 py-3 outline-none focus:border-accent";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const GOALS: { kind: string; label: string; hint: string }[] = [
  { kind: "5k", label: "5 km", hint: "Get faster over 5 km" },
  { kind: "10k", label: "10 km", hint: "Get faster over 10 km" },
  { kind: "half", label: "Half marathon", hint: "21.1 km" },
  { kind: "marathon", label: "Marathon", hint: "42.2 km" },
  { kind: "race", label: "Other race", hint: "Any distance and date" },
  { kind: "general", label: "General fitness", hint: "Fitter all round" },
  { kind: "endurance", label: "Endurance", hint: "Run longer, comfortably" },
  { kind: "consistency", label: "Consistency", hint: "Run regularly, mostly easy" },
  { kind: "volume", label: "More volume", hint: "Build weekly km safely" },
  { kind: "maintain", label: "Maintain", hint: "Keep what you have" },
];

export interface PlanFormDefaults {
  runDays: number[];
  longRunDay: number;
  today: string;
}

export function PlanForm({ defaults, replacing }: { defaults: PlanFormDefaults; replacing?: boolean }) {
  const [state, action, pending] = useActionState<PlanFormState, FormData>(createPlanAction, {});
  const [kind, setKind] = useState("half");
  const [runDays, setRunDays] = useState<number[]>(defaults.runDays);
  const isRace = ["5k", "10k", "half", "marathon", "race"].includes(kind);

  return (
    <form action={action} className="space-y-6">
      {replacing && <input type="hidden" name="replacing" value="1" />}
      <section>
        <h2 className="mb-2 font-semibold">What are you training for?</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {GOALS.map((g) => (
            <label key={g.kind} className={clsx("cursor-pointer rounded-xl border p-3 transition-colors", kind === g.kind ? "border-accent bg-accent/10" : "border-border bg-surface-2")}>
              <input type="radio" name="kind" value={g.kind} checked={kind === g.kind} onChange={() => setKind(g.kind)} className="sr-only" />
              <span className="block text-sm font-semibold">{g.label}</span>
              <span className="block text-xs text-muted">{g.hint}</span>
            </label>
          ))}
        </div>
      </section>

      {isRace && (
        <section className="space-y-3">
          {kind === "race" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Race name">
                <input name="name" className={input} placeholder="e.g. Oslo 15K" />
              </Field>
              <Field label="Distance">
                <input name="distance_km" inputMode="decimal" className={input} placeholder="km" />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Race date" hint={kind === "race" ? undefined : "Optional. Without one, the plan ends with a time trial."}>
              <input name="race_date" type="date" min={defaults.today} className={input} />
            </Field>
            <Field label="Target time" hint="Optional, h:mm:ss or mm:ss">
              <input name="target_time" className={input} placeholder={kind === "5k" ? "24:00" : kind === "10k" ? "50:00" : kind === "half" ? "1:50:00" : "3:59:00"} />
            </Field>
          </div>
        </section>
      )}
      {kind === "volume" && (
        <Field label="Weekly distance to build to" hint="Optional">
          <input name="target_weekly_km" inputMode="decimal" className={input} placeholder="km per week" />
        </Field>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">When can you run?</h2>
        <div className="grid grid-cols-7 gap-1.5">
          {DAYS.map((d, i) => (
            <label key={d} className={clsx("cursor-pointer rounded-lg border py-2 text-center text-xs font-semibold", runDays.includes(i) ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface-2 text-muted")}>
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
            <select name="long_run_day" defaultValue={defaults.longRunDay} className={input}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max hours per week" hint="Optional">
            <input name="max_weekly_hours" inputMode="decimal" className={input} placeholder="e.g. 5" />
          </Field>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Days you can never run (optional)</summary>
          <p className="mt-2 text-xs text-muted">You will get a warning if you move a workout onto one of these days.</p>
          <div className="mt-2 grid grid-cols-7 gap-1.5">
            {DAYS.map((d, i) => (
              <label key={d} className="flex flex-col items-center gap-1 text-xs">
                <input type="checkbox" name="unavailable_days" value={i} />
                {d}
              </label>
            ))}
          </div>
        </details>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <input name="start_date" type="date" min={defaults.today} defaultValue={defaults.today} className={input} />
        </Field>
        <Field label="Length" hint="Used when there is no race date">
          <select name="weeks" defaultValue="12" className={input}>
            {[4, 6, 8, 10, 12, 16, 20, 24].map((w) => (
              <option key={w} value={w}>
                {w} weeks
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="space-y-2 text-sm">
        <Toggle name="intervals" label="Include interval sessions" />
        <Toggle name="long_runs" label="Include long runs" />
        <Toggle name="strides" label="Include strides on easy days" />
      </section>

      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-fg disabled:opacity-60">
        {pending ? "Building your plan…" : replacing ? "Build new plan" : "Build my plan"}
      </button>
    </form>
  );
}

function Toggle({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-4 py-3">
      {label}
      <input type="checkbox" name={name} defaultChecked className="h-5 w-5 accent-[var(--accent)]" />
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
