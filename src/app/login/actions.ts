"use server";

import { headers } from "next/headers";
import { createUserClient } from "@/lib/db/server";
import { env } from "@/lib/env";

export interface LoginState {
  sent: boolean;
  error?: string;
}

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { sent: false, error: "Enter a valid email address." };
  // Same response whether or not the address is allowed, so the allowed address isn't revealed.
  if (email !== env.allowedEmail()) return { sent: true };
  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host")}`;
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback`, shouldCreateUser: true },
  });
  if (error) return { sent: false, error: "Could not send the sign-in link. Try again in a minute." };
  return { sent: true };
}
