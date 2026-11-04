import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readOnboarding, type OnboardingFacts } from "./state";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function loadPreferences(db: SupabaseClient, userId: string): Promise<Record<string, any>> {
  const { data } = await db.from("athlete_profile").select("preferences").eq("user_id", userId).maybeSingle();
  return (data?.preferences as Record<string, any>) ?? {};
}

/** Merges into athlete_profile.preferences; object values are merged one level deep. */
export async function updatePreferences(db: SupabaseClient, userId: string, patch: Record<string, Record<string, unknown>>) {
  const prefs = await loadPreferences(db, userId);
  const next: Record<string, any> = { ...prefs };
  for (const [k, v] of Object.entries(patch)) next[k] = { ...(prefs[k] ?? {}), ...v };
  const { error } = await db.from("athlete_profile").upsert({ user_id: userId, preferences: next });
  if (error) throw new Error(`athlete_profile: ${error.message}`);
}

export async function loadOnboardingFacts(db: SupabaseClient, userId: string): Promise<OnboardingFacts & { runCount: number }> {
  const [integ, runs, jobs, plan, prefs] = await Promise.all([
    db.from("integrations").select("status").eq("user_id", userId).in("provider", ["garmin", "strava"]),
    db.from("activities").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("sport", "running").is("duplicate_of", null),
    db.from("sync_jobs").select("status").eq("user_id", userId).eq("kind", "historical"),
    db.from("training_plans").select("id").eq("user_id", userId).eq("status", "active").maybeSingle(),
    loadPreferences(db, userId),
  ]);
  const statuses = (integ.data ?? []).map((r: { status: string }) => r.status);
  const runCount = runs.count ?? 0;
  const hist = jobs.data ?? [];
  return {
    // Garmin or Strava: either one is a working activity source
    garminConnected: statuses.some((st) => st === "connected" || st === "error"),
    historyImported: runCount > 0 || hist.some((j) => j.status === "completed"),
    importRunning: hist.some((j) => ["queued", "discovering", "processing"].includes(j.status)),
    hasPlan: !!plan.data,
    prefs: readOnboarding(prefs),
    runCount,
  };
}
