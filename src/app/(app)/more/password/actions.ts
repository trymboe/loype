"use server";

import { createUserClient, getSessionUser } from "@/lib/db/server";

export interface SetPasswordState {
  ok?: boolean;
  error?: string;
}

export async function setPassword(_prev: SetPasswordState, form: FormData): Promise<SetPasswordState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (password.length < 10) return { error: "Use at least 10 characters." };
  if (password !== confirm) return { error: "The two passwords don't match." };
  const supabase = await createUserClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "weak_password") return { error: "Supabase rejected that password as too weak. Try a longer one." };
    if (error.code === "same_password") return { ok: true };
    if (error.code === "reauthentication_needed")
      return { error: "Supabase wants a fresh sign-in first. Sign out, sign in with an email link, then set the password." };
    return { error: `Could not save the password (${error.message}).` };
  }
  return { ok: true };
}
