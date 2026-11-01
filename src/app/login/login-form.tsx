"use client";

import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { sent: false });
  if (state.sent) {
    return <p className="text-muted">If that address belongs to this app, a sign-in link is on its way. Open it on this device.</p>;
  }
  return (
    <form action={action} className="space-y-3">
      <input
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="you@example.com"
        className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 outline-none focus:border-accent"
      />
      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-fg disabled:opacity-60">
        {pending ? "Sending…" : "Send sign-in link"}
      </button>
    </form>
  );
}
