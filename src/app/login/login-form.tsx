"use client";

import { useActionState } from "react";
import { sendMagicLink, verifyCode, type CodeState, type LoginState } from "./actions";

const input = "w-full rounded-xl border border-border bg-surface-2 px-4 py-3 outline-none focus:border-accent";
const button = "w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-fg disabled:opacity-60";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { sent: false });
  if (state.sent) return <CodeForm email={state.email ?? ""} />;
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={input} />
      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}

function CodeForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<CodeState, FormData>(verifyCode, {});
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted">
        If that address belongs to this app, an email is on its way. Open its link in this same browser. If the email also shows a code, you can enter it below instead.
      </p>
      <input type="hidden" name="email" value={email} />
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        placeholder="Code (optional)"
        className={`${input} tabular text-center text-2xl tracking-[0.4em]`}
      />
      {state.error && <p className="text-sm text-hr">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
