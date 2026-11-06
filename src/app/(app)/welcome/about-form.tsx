"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import { EXPERIENCE_LABEL, type AthleteBackground, type Experience } from "@/lib/onboarding/state";
import { saveAboutAction, type AboutState } from "./actions";

interface Initial {
  max_hr: number | null;
  resting_hr: number | null;
  birth_year: number | null;
  sex: string | null;
}

export function AboutForm({ initial, background, detected }: { initial: Initial; background: AthleteBackground; detected: { maxHr: string | null; restHr: string | null } }) {
  const [state, action, pending] = useActionState<AboutState, FormData>(saveAboutAction, {});
  const [exp, setExp] = useState<Experience | null>(background.experience);
  const [injury, setInjury] = useState(background.injuryConcern);

  return (
    <form action={action} className="space-y-7">
      <section>
        <h2 className="section-title mb-3">Running experience</h2>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(EXPERIENCE_LABEL) as Experience[]).map((k) => (
            <label
              key={k}
              className={clsx(
                "cursor-pointer rounded-2xl p-3.5 ring-inset transition-all active:scale-[0.98]",
                exp === k ? "bg-accent/10 ring-2 ring-accent" : "bg-surface-2 ring-1 ring-transparent hover:bg-surface-3",
              )}
            >
              <input type="radio" name="experience" value={k} checked={exp === k} onChange={() => setExp(k)} className="sr-only" />
              <span className="block text-sm font-semibold">{EXPERIENCE_LABEL[k].label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="section-title">What training suits you?</h2>
        <div className="divide-hairline overflow-hidden rounded-2xl bg-surface-2 text-[0.9375rem]">
          <Toggle name="intervals" label="Interval and threshold sessions" checked={background.intervals} />
          <Toggle name="long_runs" label="A weekly long run" checked={background.longRuns} />
          <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 bg-surface-2 px-4 py-3">
            <span>An injury or niggle to work around</span>
            <input type="checkbox" name="injury" checked={injury} onChange={(e) => setInjury(e.target.checked)} className="switch" />
          </label>
        </div>
        {injury && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">What is it?</span>
            <textarea name="injury_note" rows={2} maxLength={500} defaultValue={background.injuryNote ?? ""} placeholder="e.g. Achilles gets sore after hills" className="input" />
          </label>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="section-title">Heart rate and body (optional)</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max HR (bpm)">
            <input name="max_hr" type="number" inputMode="numeric" min={100} max={240} defaultValue={initial.max_hr ?? ""} placeholder={detected.maxHr ? `Auto: ${detected.maxHr}` : "Auto"} className="input" />
          </Field>
          <Field label="Resting HR (bpm)">
            <input name="resting_hr" type="number" inputMode="numeric" min={25} max={120} defaultValue={initial.resting_hr ?? ""} placeholder={detected.restHr ? `Auto: ${detected.restHr}` : "Auto"} className="input" />
          </Field>
          <Field label="Birth year">
            <input name="birth_year" type="number" inputMode="numeric" defaultValue={initial.birth_year ?? ""} placeholder="e.g. 1994" className="input" />
          </Field>
          <Field label="Sex">
            <select name="sex" defaultValue={initial.sex ?? ""} className="input">
              <option value="">Not set</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </Field>
        </div>
      </section>

      {state.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{state.error}</p>}
      <button disabled={pending || !exp} className="btn btn-primary btn-block min-h-12">
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

function Toggle({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 bg-surface-2 px-4 py-3">
      <span>{label}</span>
      <input type="checkbox" name={name} defaultChecked={checked} className="switch" />
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
    </label>
  );
}
