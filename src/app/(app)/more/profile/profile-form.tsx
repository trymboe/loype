"use client";

import { useActionState } from "react";
import { saveProfile, type ProfileState } from "./actions";
import { SubmitButton } from "@/components/feedback/submit-button";

const input = "input";

interface Initial {
  max_hr: number | null;
  resting_hr: number | null;
  birth_year: number | null;
  sex: string | null;
  weight_kg: number | null;
}

export function ProfileForm({ initial, detected }: { initial: Initial; detected: { maxHr: string | null; restHr: string | null } }) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveProfile, {});
  return (
    <form action={action} className="space-y-5">
      <Field label="Max heart rate (bpm)">
        <input name="max_hr" type="number" inputMode="numeric" min={100} max={240} defaultValue={initial.max_hr ?? ""} placeholder={detected.maxHr ? `Auto: ${detected.maxHr}` : "Auto"} className={input} />
      </Field>
      <Field label="Resting heart rate (bpm)">
        <input name="resting_hr" type="number" inputMode="numeric" min={25} max={120} defaultValue={initial.resting_hr ?? ""} placeholder={detected.restHr ? `Auto: ${detected.restHr}` : "Auto"} className={input} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Birth year">
          <input name="birth_year" type="number" inputMode="numeric" defaultValue={initial.birth_year ?? ""} placeholder="e.g. 1994" className={input} />
        </Field>
        <Field label="Weight (kg)">
          <input name="weight_kg" type="number" inputMode="decimal" step="0.1" defaultValue={initial.weight_kg ?? ""} className={input} />
        </Field>
      </div>
      <Field label="Sex">
        <select name="sex" defaultValue={initial.sex ?? ""} className={input}>
          <option value="">Not set</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="other">Other</option>
        </select>
      </Field>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">Saved</p>}
      <SubmitButton disabled={pending} className="btn btn-primary btn-block min-h-12">
        {pending ? "Saving…" : "Save"}
      </SubmitButton>
    </form>
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
