"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/db/server";
import { env } from "@/lib/env";

export interface LoginState {
  sent: boolean;
  email?: string;
  error?: string;
}

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { sent: false, error: "Enter a valid email address." };
  // Same response whether or not the address is allowed, so the allowed address isn't revealed.
  if (email !== env.allowedEmail()) return { sent: true, email };
  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host")}`;
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback`, shouldCreateUser: true },
  });
  if (error) {
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
  if (email !== env.allowedEmail()) return { error: "That code is invalid or has expired." };
  const supabase = await createUserClient();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) return { error: "That code is invalid or has expired. Request a new email." };
  redirect("/");
}
