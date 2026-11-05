"use client";

import { useActionState, useEffect, useRef } from "react";
import { changePassword, type ChangePasswordState } from "./actions";

const input = "input";

export function PasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<ChangePasswordState, FormData>(changePassword, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={action} className="space-y-3">
      {/* lets password managers attach the password to the right account */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <input name="current" type="password" autoComplete="current-password" required placeholder="Current password" aria-label="Current password" className={input} />
      <input name="password" type="password" autoComplete="new-password" required minLength={10} placeholder="New password" aria-label="New password" className={input} />
      <input name="confirm" type="password" autoComplete="new-password" required minLength={10} placeholder="Confirm new password" aria-label="Confirm new password" className={input} />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">Password changed.</p>}
      <button disabled={pending} className="btn btn-primary btn-block min-h-12">
        {pending ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
