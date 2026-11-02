"use client";

import { useActionState } from "react";
import { setPassword, type SetPasswordState } from "./actions";

const input = "w-full rounded-xl border border-border bg-surface-2 px-4 py-3 outline-none focus:border-accent";

export function PasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(setPassword, {});
  return (
    <form action={action} className="space-y-3">
      {/* lets password managers attach the password to the right account */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <input name="password" type="password" autoComplete="new-password" required minLength={10} placeholder="New password" className={input} />
      <input name="confirm" type="password" autoComplete="new-password" required minLength={10} placeholder="Repeat password" className={input} />
      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      {state.ok && <p className="text-sm text-accent">Password saved. You can now sign in with it on any browser or in the installed app.</p>}
      <button disabled={pending} className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-fg disabled:opacity-60">
        {pending ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
