"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import type { AthleteBackground } from "@/lib/onboarding/state";
import { createPlanAction, type PlanFormState } from "./actions";
import { DAYS, GOALS } from "./goal-options";
import { SubmitButton } from "@/components/feedback/submit-button";

const input = "input";

export interface PlanFormDefaults {
  runDays: number[];
  longRunDay: number | null;
  today: string;
  /** average runs per week over the last 4 weeks */
  recentRuns: number;
  /** your usual run length (median, last 8 weeks), if any */
  runMinutes: number | null;
  /** what the athlete told us during setup */
  background?: AthleteBackground;
}

export function PlanForm({ defaults }: { defaults: PlanFormDefaults }) {
  const [state, action, pending] = useActionState<PlanFormState, FormData>(createPlanAction, {});
  const [kind, setKind] = useState("half");
  const [runDays, setRunDays] = useState<number[]>(defaults.runDays);
  const isRace = ["5k", "10k", "half", "marathon", "race"].includes(kind);

  return (
    <form action={action} className="space-y-7">
      <section>
        <h2 className="section-title mb-3">What are you training for?</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {GOALS.map((g) => (
            <label
              key={g.kind}
              className={clsx(
                "cursor-pointer rounded-2xl p-3.5 ring-inset transition-all active:scale-[0.98]",
                kind === g.kind ? "bg-accent/10 ring-2 ring-accent" : "bg-surface-2 ring-1 ring-transparent hover:bg-surface-3",
              )}
            >
              <input type="radio" name="kind" value={g.kind} checked={kind === g.kind} onChange={() => setKind(g.kind)} className="sr-only" />
              <span className="block text-sm font-semibold">{g.label}</span>
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
            <Field label={kind === "race" ? "Race date" : "Race date (optional)"}>
              <input name="race_date" type="date" min={defaults.today} className={input} />
            </Field>
            <Field label="Target time (optional)">
              <input name="target_time" className={input} placeholder={kind === "5k" ? "24:00" : kind === "10k" ? "50:00" : kind === "half" ? "1:50:00" : "3:59:00"} />
            </Field>
          </div>
        </section>
      )}
      {kind === "volume" && (
        <Field label="Weekly km goal (optional)">
          <input name="target_weekly_km" inputMode="decimal" className={input} placeholder="km per week" />
        </Field>
      )}

      <section className="space-y-3">
        <h2 className="section-title">Days you can run</h2>
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
            <select name="long_run_day" defaultValue={defaults.longRunDay ?? ""} className={input}>
              <option value="">Best fit</option>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max hours a week (optional)">
            <input name="max_weekly_hours" inputMode="decimal" className={input} placeholder="e.g. 5" />
          </Field>
        </div>
        <FrequencyPicker dayCount={runDays.length} recentRuns={defaults.recentRuns} runMinutes={defaults.runMinutes} />
        <TrainingStylePicker />
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <input name="start_date" type="date" min={defaults.today} defaultValue={defaults.today} className={input} />
        </Field>
        <Field label={isRace ? "Length if no race date" : "Length"}>
          <select name="weeks" defaultValue="12" className={input}>
            {[4, 6, 8, 10, 12, 16, 20, 24].map((w) => (
              <option key={w} value={w}>
                {w} weeks
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="divide-hairline overflow-hidden rounded-2xl bg-surface-2 text-[0.9375rem]">
        <Toggle name="intervals" label="Include interval sessions" defaultChecked={defaults.background?.intervals ?? true} />
        <Toggle name="long_runs" label="Include long runs" defaultChecked={defaults.background?.longRuns ?? true} />
        <Toggle name="strides" label="Include strides on easy days" />
        <Toggle name="time_trial" label="Start with a time trial" />
      </section>
      {defaults.background?.injuryConcern && (
        <p className="rounded-xl bg-warn/10 p-3 text-sm leading-snug">
          You noted an injury to work around{defaults.background.injuryNote ? `: “${defaults.background.injuryNote}”` : ""}. Leave rest days between runs and
          turn off sessions that aggravate it.
        </p>
      )}

      {state.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{state.error}</p>}
      <SubmitButton disabled={pending} className="btn btn-primary btn-block min-h-12">
        {pending ? "Building your plan…" : "Build my plan"}
      </SubmitButton>
    </form>
  );
}

/** Runs per week: Auto (from your history, or a frequency you enter) or a fixed number. */
export function FrequencyPicker({
  dayCount,
  recentRuns,
  initialFixed = null,
  initialUsual = "",
}: {
  dayCount: number;
  recentRuns: number;
  runMinutes?: number | null;
  initialFixed?: number | null;
  initialUsual?: string;
}) {
  const [fixed, setFixed] = useState<number | null>(initialFixed);
  const options: (number | null)[] = [null, 1, 2, 3, 4, 5, 6, 7];
  const noHistory = recentRuns === 0;
  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1.5 block text-sm font-semibold">Runs per week in the plan</span>
        <div className="grid grid-cols-8 gap-1.5">
          {options.map((o) => {
            const tooMany = o != null && o > dayCount;
            return (
              <label
                key={o ?? "auto"}
                className={clsx(
                  "rounded-xl py-2.5 text-center text-xs font-semibold transition-colors",
                  o == null && "col-span-1",
                  tooMany ? "cursor-default opacity-40" : "cursor-pointer",
                  fixed === o ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                <input type="radio" name="frequency" value={o ?? "auto"} checked={fixed === o} disabled={tooMany} onChange={() => setFixed(o)} className="sr-only" />
                {o ?? "Auto"}
              </label>
            );
          })}
        </div>
      </div>
      {fixed == null && (
        <Field label={noHistory ? "Runs a week right now" : "Runs a week right now (optional)"}>
          <input name="usual_runs" inputMode="decimal" defaultValue={initialUsual} className="input" placeholder={noHistory ? "e.g. 2" : String(recentRuns)} />
        </Field>
      )}
    </div>
  );
}

export function Toggle({ name, label, defaultChecked = true }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 bg-surface-2 px-4 py-3">
      {label}
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="switch" />
    </label>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
    </label>
  );
}

const VOLUME_OPTIONS = [
  { v: "gradual", label: "Gradual" },
  { v: "steady", label: "Steady" },
  { v: "progressive", label: "Progressive" },
] as const;
const INTENSITY_OPTIONS = [
  { v: "comfortable", label: "Comfortable" },
  { v: "balanced", label: "Balanced" },
  { v: "challenging", label: "Challenging" },
] as const;

/** Training volume and session intensity (like Runna's Training Preferences). */
export function TrainingStylePicker({ initialVolume = "steady", initialIntensity = "balanced" }: { initialVolume?: string; initialIntensity?: string }) {
  const [volume, setVolume] = useState(initialVolume);
  const [intensity, setIntensity] = useState(initialIntensity);
  const group = (name: string, label: string, opts: readonly { v: string; label: string }[], value: string, set: (v: string) => void) => (
    <div>
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      <div className="grid grid-cols-3 gap-1.5">
        {opts.map((o) => (
          <label key={o.v} className={clsx("cursor-pointer rounded-xl py-2.5 text-center text-xs font-semibold transition-colors", value === o.v ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg")}>
            <input type="radio" name={name} value={o.v} checked={value === o.v} onChange={() => set(o.v)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      {group("volume", "Training volume", VOLUME_OPTIONS, volume, setVolume)}
      {group("intensity", "Session intensity", INTENSITY_OPTIONS, intensity, setIntensity)}
    </div>
  );
}
