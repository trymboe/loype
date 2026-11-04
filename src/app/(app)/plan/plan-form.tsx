"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import type { AthleteBackground } from "@/lib/onboarding/state";
import { createPlanAction, type PlanFormState } from "./actions";
import { DAYS, GOALS } from "./goal-options";

const input = "input";

export interface PlanFormDefaults {
  runDays: number[];
  longRunDay: number;
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
              <span className="mt-0.5 block text-xs leading-snug text-muted">{g.hint}</span>
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
        <h2 className="section-title">Which days could you run?</h2>
        <p className="-mt-1 text-xs text-muted">Tick every day that can work. Løype picks the best of them and keeps the rest as rest days.</p>
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
        <FrequencyPicker dayCount={runDays.length} recentRuns={defaults.recentRuns} runMinutes={defaults.runMinutes} />
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

      <section className="divide-hairline overflow-hidden rounded-2xl bg-surface-2 text-[0.9375rem]">
        <Toggle name="intervals" label="Include interval sessions" defaultChecked={defaults.background?.intervals ?? true} />
        <Toggle name="long_runs" label="Include long runs" defaultChecked={defaults.background?.longRuns ?? true} />
        <Toggle name="strides" label="Include strides on easy days" />
      </section>
      {defaults.background?.injuryConcern && (
        <p className="rounded-xl bg-warn/10 p-3 text-sm leading-snug">
          You noted an injury to work around{defaults.background.injuryNote ? `: “${defaults.background.injuryNote}”` : ""}. Leave rest days between runs and
          turn off sessions that aggravate it.
        </p>
      )}

      {state.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{state.error}</p>}
      <button disabled={pending} className="btn btn-primary btn-block min-h-12">
        {pending ? "Building your plan…" : "Build my plan"}
      </button>
    </form>
  );
}

/** Runs per week: Auto (from your history, or a frequency you enter) or a fixed number. */
export function FrequencyPicker({
  dayCount,
  recentRuns,
  runMinutes,
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
        <span className="mb-1.5 block text-sm font-semibold">Runs per week</span>
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
      {fixed == null ? (
        <>
          <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
            {noHistory
              ? "No runs synced lately, so tell Løype how often you run now and it starts from there. "
              : `Auto: you have averaged ${recentRuns} runs a week lately${runMinutes ? `, usually about ${runMinutes} min each` : ""}, so the plan starts from that. `}
            It only adds time and runs as fast as is considered safe (about 10 % a week, and never more than 1.3× your last four weeks), and each week it is recalculated from what you actually ran.
          </p>
          <Field label="How often do you run now?" hint={noHistory ? "Times per week. Leave empty if you're starting from scratch." : "Optional. Replaces the measured frequency, e.g. if not all your runs are synced."}>
            <input name="usual_runs" inputMode="decimal" defaultValue={initialUsual} className="input" placeholder={noHistory ? "e.g. 2" : String(recentRuns)} />
          </Field>
        </>
      ) : (
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
          Every week has {fixed} run{fixed === 1 ? "" : "s"}, spread over the days you ticked. The weekly time still builds safely from what you actually run, so it&apos;s divided over {fixed} run{fixed === 1 ? "" : "s"}.
        </p>
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-snug text-muted">{hint}</span>}
    </label>
  );
}
