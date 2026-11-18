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
  cronSecret: () => required("CRON_SECRET"),
  garminBaseUrl: () => process.env.GARMIN_API_BASE_URL || undefined,
  /** Anthropic API key: the coach runs on Claude when it's set. */
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || null,
  /** Claude model for the coach. */
  claudeModel: () => process.env.COACH_CLAUDE_MODEL || "claude-sonnet-5-5",
  /** OpenAI API key: the coach's fallback (or the only provider when there's no Anthropic key). */
  openaiApiKey: () => process.env.OPENAI_API_KEY || null,
  /** OpenAI model for the coach's fallback. */
  coachModel: () => process.env.COACH_MODEL || "gpt-6-luna",
};

export function isConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
