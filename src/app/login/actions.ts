"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/db/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";

export interface LoginState {
  sent: boolean;
  email?: string;
  error?: string;
}

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { sent: false, error: "Enter a valid email address." };
  // Same response whether or not the address is allowed, so who is allowed isn't revealed.
  if (!isAllowedEmail(email)) return { sent: true, email };
  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host")}`;
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback`, shouldCreateUser: true },
  });
  if (error) {
    if (error.code === "email_address_not_authorized") {
      // Supabase's built-in mailer only reaches the project's own team until custom SMTP is set up.
      return {
        sent: false,
        error: "Sign-in emails can't reach this address yet. Ask whoever runs Løype for a password, and sign in with it below.",
      };
    }
    if (error.code === "over_email_send_rate_limit" || error.status === 429) {
      return {
        sent: false,
        error: "Too many emails requested. Supabase's built-in mail only sends a few per hour. Use the most recent email you got, or wait and try again.",
      };
    }
    return { sent: false, error: "Could not send the sign-in email. Try again in a minute." };
  }
  return { sent: true, email };
}

export interface CodeState {
  error?: string;
}

/** Sign in with the 6-digit code from the email. Works on any device, unlike the link. */
export async function verifyCode(_prev: CodeState, form: FormData): Promise<CodeState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const token = String(form.get("code") ?? "").replace(/\s/g, "");
  if (!/^\d{6,10}$/.test(token)) return { error: "Enter the code from the email." };
  if (!isAllowedEmail(email)) return { error: "That code is invalid or has expired." };
  const supabase = await createUserClient();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) return { error: "That code is invalid or has expired. Request a new email." };
  redirect("/");
}

export interface PasswordState {
  error?: string;
}

/**
 * Email + password sign-in. Needs no email, so it works inside an installed
 * iPhone home-screen app, which has its own storage separate from Safari and
 * never receives magic links. The password is set under More → Password.
 */
export async function signInWithPassword(_prev: PasswordState, form: FormData): Promise<PasswordState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const generic = { error: "Wrong email or password. If you haven't set a password yet, use an email link first." };
  if (!email.includes("@") || !password) return generic;
  if (!isAllowedEmail(email)) return generic;
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a minute and try again." };
    return generic;
  }
  redirect("/");
}
