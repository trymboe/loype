import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "../env";

/** Supabase client acting as the signed-in user (RLS applies). */
export async function createUserClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a Server Component; middleware refreshes the session instead
        }
      },
    },
  });
}

/** Service-role client for background jobs. Bypasses RLS: always scope queries by user_id. */
export function createAdminClient(): SupabaseClient {
  return createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Returns the signed-in, allowed user or null. */
export async function getSessionUser() {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user || user.email?.toLowerCase() !== env.allowedEmail()) return null;
  return user;
}
