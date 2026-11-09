"use client";

import { useActionState } from "react";
import { applyThresholdAction, connectIntervalsAction, disconnectIntervalsAction, pushNowAction, type IntervalsState } from "./intervals-actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export function IntervalsKeyForm({ replacing }: { replacing: boolean }) {
  const [state, action, pending] = useActionState<IntervalsState, FormData>(connectIntervalsAction, {});
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">API key</span>
        <input name="apiKey" type="password" autoComplete="off" required className="input font-mono" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">
          Athlete ID (optional)
        </span>
        <input name="athleteId" autoComplete="off" className="input font-mono" placeholder="i123456" />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.message && <p className="text-sm text-good">{state.message}</p>}
      <SubmitButton disabled={pending} className="btn btn-primary btn-block">
        {pending ? "Checking with Intervals.icu…" : replacing ? "Replace key" : "Connect Intervals.icu"}
      </SubmitButton>
    </form>
  );
}

export function IntervalsPushControls() {
  const [state, action, pending] = useActionState<IntervalsState, FormData>(pushNowAction, {});
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={action}>
          <SubmitButton disabled={pending} className="btn btn-primary btn-sm">
            {pending ? "Sending…" : "Send upcoming workouts now"}
          </SubmitButton>
        </form>
        <form action={disconnectIntervalsAction}>
          <SubmitButton className="btn btn-secondary btn-sm">Disconnect</SubmitButton>
        </form>
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.message && <p className="text-sm text-good">{state.message}</p>}
    </div>
  );
}

export function ApplyThresholdButton({ pace }: { pace: string }) {
  const [state, action, pending] = useActionState<IntervalsState, FormData>(applyThresholdAction, {});
  return (
    <form action={action} className="space-y-2">
      <SubmitButton disabled={pending} className="btn btn-primary btn-sm">
        {pending ? "Updating Intervals.icu…" : `Set threshold pace to ${pace}/km in Intervals.icu`}
      </SubmitButton>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.message && <p className="text-sm text-good">{state.message}</p>}
    </form>
  );
}
