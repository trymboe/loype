"use client";

import { useActionState } from "react";
import { connectGarmin, type KeyState } from "./actions";

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
          Key expires on <span className="font-normal text-muted">(optional, for reminders)</span>
        </span>
        <input name="expiresAt" type="date" className="input" />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">Connected. Garmin accepted the key.</p>}
      <button disabled={pending} className="btn btn-primary btn-block">
        {pending ? "Verifying with Garmin…" : replacing ? "Replace key" : "Connect Garmin"}
      </button>
      <p className="text-xs text-muted">The key is encrypted before it is stored and never sent to your browser again.</p>
    </form>
  );
}
