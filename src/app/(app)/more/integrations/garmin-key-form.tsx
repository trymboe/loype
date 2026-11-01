"use client";

import { useActionState } from "react";
import { connectGarmin, type KeyState } from "./actions";

export function GarminKeyForm({ replacing }: { replacing: boolean }) {
  const [state, action, pending] = useActionState<KeyState, FormData>(connectGarmin, {});
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="label">Personal API key</span>
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-4 py-3 font-mono text-sm outline-none focus:border-accent"
        />
      </label>
      <label className="block">
        <span className="label">Key expires on (optional, for reminders)</span>
        <input name="expiresAt" type="date" className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm outline-none focus:border-accent" />
      </label>
      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      {state.ok && <p className="text-sm text-accent">Connected. Garmin accepted the key.</p>}
      <button disabled={pending} className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-accent-fg disabled:opacity-60">
        {pending ? "Verifying with Garmin…" : replacing ? "Replace key" : "Connect Garmin"}
      </button>
      <p className="text-xs text-muted">The key is encrypted before it is stored and never sent to your browser again.</p>
    </form>
  );
}
