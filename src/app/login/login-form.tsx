"use client";

import { useActionState, useState } from "react";
import {
  sendMagicLink,
  signInWithPassword,
  verifyCode,
  type CodeState,
  type LoginState,
  type PasswordState,
} from "./actions";

const input = "input";
const button = "btn btn-primary btn-block min-h-12";

const linkButton = "w-full py-2 text-center text-sm font-medium text-muted transition-colors hover:text-fg";

export function LoginForm() {
  const [mode, setMode] = useState<"password" | "email">("password");
  return mode === "password" ? (
    <div className="space-y-5">
      <PasswordForm />
      <button type="button" onClick={() => setMode("email")} className={linkButton}>
        No password yet? Email me a sign-in link
      </button>
    </div>
  ) : (
    <div className="space-y-5">
      <EmailLinkForm />
      <button type="button" onClick={() => setMode("password")} className={linkButton}>
        Sign in with password instead
      </button>
    </div>
  );
}

function PasswordForm() {
  const [state, action, pending] = useActionState<PasswordState, FormData>(signInWithPassword, {});
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" autoComplete="username" required placeholder="you@example.com" className={input} />
      <input name="password" type="password" autoComplete="current-password" required placeholder="Password" className={input} />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function EmailLinkForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { sent: false });
  if (state.sent) return <CodeForm email={state.email ?? ""} />;
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={input} />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
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
        Check your email and open the link in this browser, or enter the code.
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
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
