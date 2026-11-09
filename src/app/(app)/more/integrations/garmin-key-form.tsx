"use client";

import { useActionState } from "react";
import { connectGarmin, type KeyState } from "./actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export function GarminKeyForm({ replacing }: { replacing: boolean }) {
  const [state, action, pending] = useActionState<KeyState, FormData>(connectGarmin, {});
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">Personal API key</span>
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          className="input font-mono"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">
          Key expiry date (optional)
        </span>
        <input name="expiresAt" type="date" className="input" />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">Connected</p>}
      <SubmitButton disabled={pending} className="btn btn-primary btn-block">
        {pending ? "Verifying with Garmin…" : replacing ? "Replace key" : "Connect Garmin"}
      </SubmitButton>
    </form>
  );
}
