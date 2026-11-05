/** Centralised, validated access to environment variables (server-side only unless NEXT_PUBLIC_). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See docs/SETUP.md.`);
  return v;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  allowedEmail: () => required("ALLOWED_EMAIL").toLowerCase(),
  cronSecret: () => required("CRON_SECRET"),
  garminApiKey: () => process.env.GARMIN_PERSONAL_API_KEY || null,
  garminBaseUrl: () => process.env.GARMIN_API_BASE_URL || undefined,
  /** OpenAI API key for the coach; the Coach tab explains how to add it when missing. */
  openaiApiKey: () => process.env.OPENAI_API_KEY || null,
  coachModel: () => process.env.COACH_MODEL || "gpt-6-luna",
};

export function isConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
