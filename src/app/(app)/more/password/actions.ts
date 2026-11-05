"use server";

import { createClient } from "@supabase/supabase-js";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { env } from "@/lib/env";

export interface ChangePasswordState {
  ok?: boolean;
  error?: string;
}

const MIN_LENGTH = 10;

/** Throwaway client: checks the current password without touching the browser's session cookies. */
async function isCurrentPassword(email: string, password: string): Promise<boolean> {
  const probe = createClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await probe.auth.signInWithPassword({ email, password });
  if (error) return false;
  // End only the probe session; the user's own sign-in stays.
  await probe.auth.signOut({ scope: "local" });
  return true;
}

export async function changePassword(_prev: ChangePasswordState, form: FormData): Promise<ChangePasswordState> {
  const user = await getSessionUser();
  if (!user?.email) return { error: "Not signed in." };
  const current = String(form.get("current") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (!current) return { error: "Enter your current password." };
  if (password.length < MIN_LENGTH) return { error: `New password must be at least ${MIN_LENGTH} characters.` };
  if (password !== confirm) return { error: "New passwords don't match." };
  if (password === current) return { error: "New password must be different from the current one." };
  if (!(await isCurrentPassword(user.email, current))) return { error: "Current password is incorrect." };

  const supabase = await createUserClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "weak_password") return { error: "New password is too weak." };
    return { error: "Could not change the password. Try again." };
  }
  return { ok: true };
}
