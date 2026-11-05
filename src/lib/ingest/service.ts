import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIn } from "../dates";
import { recomputeFitness, type RecomputeResult } from "../fitness/service";
import { runPlanMaintenance } from "../planning/service";
import { decryptSecret, encryptSecret, fingerprint } from "../crypto/secretbox";
import { env } from "../env";
import { GarminAuthError, GarminPersonalApiClient, type TokenStore } from "../integrations/garmin/client";
import { isoDate, runSyncTick, startHistoricalImport, type TickResult } from "./engine";
import { SupabaseIngestRepo } from "./supabase-repo";
import { syncWellness, type WellnessResult } from "./wellness";
import { stravaTick } from "./strava-service";

/* eslint-disable @typescript-eslint/no-explicit-any */

const WELLNESS_INTERVAL_MS = 6 * 3600_000;

export async function getGarminIntegration(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("integrations").select("*").eq("user_id", userId).eq("provider", "garmin").maybeSingle();
  if (error) throw new Error(error.message);
  return data as any | null;
}

async function ensureIntegrationRow(db: SupabaseClient, userId: string) {
  const existing = await getGarminIntegration(db, userId);
  if (existing) return existing;
  const { data, error } = await db.from("integrations").insert({ user_id: userId, provider: "garmin" }).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveGarminApiKey(db: SupabaseClient, userId: string, apiKey: string, keyExpiresAt: string | null) {
  await ensureIntegrationRow(db, userId);
  const { error } = await db
    .from("integrations")
    .update({
      api_key_ciphertext: encryptSecret(apiKey.trim()),
      api_key_fingerprint: fingerprint(apiKey.trim()),
      api_key_expires_at: keyExpiresAt,
      secret_ciphertext: null,
      token_expires_at: null,
      status: "connected",
      last_error: null,
    })
    .eq("user_id", userId)
    .eq("provider", "garmin");
  if (error) throw new Error(error.message);
}

function tokenStore(db: SupabaseClient, userId: string): TokenStore {
  const where = (q: any) => q.eq("user_id", userId).eq("provider", "garmin");
  return {
    async load() {
      const { data } = await where(db.from("integrations").select("secret_ciphertext, token_expires_at, api_key_fingerprint")).maybeSingle();
      if (!data?.secret_ciphertext || !data.token_expires_at) return null;
      try {
        return {
          accessToken: decryptSecret(data.secret_ciphertext),
          expiresAt: new Date(data.token_expires_at),
          keyFingerprint: data.api_key_fingerprint ?? "",
        };
      } catch {
        return null;
      }
    },
    async save(t) {
      await where(
        db.from("integrations").update({
          secret_ciphertext: encryptSecret(t.accessToken),
          token_expires_at: t.expiresAt.toISOString(),
          api_key_fingerprint: t.keyFingerprint,
        }),
      );
    },
    async clear() {
      await where(db.from("integrations").update({ secret_ciphertext: null, token_expires_at: null }));
    },
  };
}

export async function buildGarminClient(db: SupabaseClient, userId: string, opts: { deadline?: number } = {}): Promise<GarminPersonalApiClient | null> {
  const row = await getGarminIntegration(db, userId);
  // Each user's own key only. No env-level fallback: with several users it
  // would import one person's Garmin data into everyone's account.
  if (!row?.api_key_ciphertext) return null;
  const apiKey = decryptSecret(row.api_key_ciphertext);
  return new GarminPersonalApiClient({ apiKey, tokenStore: tokenStore(db, userId), baseUrl: env.garminBaseUrl(), deadline: opts.deadline });
}

async function setIntegrationState(db: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  await db.from("integrations").update(patch).eq("user_id", userId).eq("provider", "garmin");
}

export interface UserTickOutcome extends Partial<TickResult> {
  configured: boolean;
  wellness?: WellnessResult;
  fitness?: RecomputeResult | { error: string };
  plan?: Awaited<ReturnType<typeof runPlanMaintenance>> | { error: string };
  error?: string;
}

/** One bounded unit of sync work for a user: activities first (Garmin, then Strava), wellness with leftover time. */
export async function syncTickForUser(
  db: SupabaseClient,
  userId: string,
  opts: { budgetMs: number; createIncremental: boolean; historicalFrom?: string; only?: "garmin" | "strava" },
): Promise<UserTickOutcome> {
  const started = Date.now();
  const deadline = started + opts.budgetMs * 0.8;
  const { data: profile } = await db.from("athlete_profile").select("timezone").eq("user_id", userId).maybeSingle();
  const tz = profile?.timezone ?? "Europe/Oslo";

  const garminOut = opts.only === "strava" ? ({ configured: false } as UserTickOutcome) : await garminTick(db, userId, tz, { ...opts, started, deadline });
  const stravaOut =
    opts.only === "garmin"
      ? { configured: false }
      : await stravaTick(db, userId, tz, { deadline, createIncremental: opts.createIncremental, historicalFrom: opts.historicalFrom });
  if (!garminOut.configured && !stravaOut.configured) return { configured: false };

  const parts = [garminOut.configured ? garminOut : null, stravaOut.configured ? stravaOut : null].filter((x): x is UserTickOutcome => x != null);
  const label = (o: UserTickOutcome) => (o === garminOut ? "Garmin" : "Strava");
  const sumCounters = parts.every((p) => !p.counters)
    ? null
    : parts.reduce(
        (acc, p) => {
          for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += p.counters?.[k] ?? 0;
          return acc;
        },
        { discovered: 0, processed: 0, failed: 0, unavailable: 0, skipped: 0, pending: 0 },
      );
  const errors = parts.filter((p) => p.error).map((p) => `${label(p)}: ${p.error}`);
  const authErrors = parts.filter((p) => p.authError).map((p) => `${label(p)}: ${p.authError}`);
  // A provider that errored, needs a reconnect or is rate limited doesn't hold the other back.
  const done = parts.every((p) => p.done || p.error || p.authError || p.paused);
  const anyImportDone = parts.some((p) => p.done);
  const result: UserTickOutcome = {
    configured: true,
    job: garminOut.job ?? stravaOut.job,
    counters: sumCounters,
    processedThisTick: parts.reduce((n, p) => n + (p.processedThisTick ?? 0), 0),
    done,
    authError: authErrors.length ? authErrors.join(" · ") : undefined,
    error: errors.length && errors.length === parts.length ? errors.join(" · ") : undefined,
    wellness: garminOut.wellness,
  };
  if (!anyImportDone || !done) return result;

  // Fitness model: cheap no-op when nothing changed, so run it whenever the queue is drained.
  let fitness: UserTickOutcome["fitness"];
  if (Date.now() < deadline) {
    try {
      fitness = await recomputeFitness(db, userId, todayIn(tz), deadline);
    } catch (e) {
      fitness = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  // Plan upkeep: link runs to planned workouts and propose adaptations (never applies them).
  let plan: UserTickOutcome["plan"];
  if (fitness && !("error" in fitness) && Date.now() < deadline) {
    try {
      plan = await runPlanMaintenance(db, userId, todayIn(tz));
    } catch (e) {
      plan = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ...result, fitness, plan };
}

/** Garmin activities + wellness. */
async function garminTick(
  db: SupabaseClient,
  userId: string,
  tz: string,
  opts: { createIncremental: boolean; historicalFrom?: string; started: number; deadline: number; budgetMs: number },
): Promise<UserTickOutcome> {
  const { started, deadline } = opts;
  const garmin = await buildGarminClient(db, userId, { deadline });
  if (!garmin) return { configured: false };
  const repo = new SupabaseIngestRepo(db, userId, tz);

  if (opts.historicalFrom) {
    await startHistoricalImport(repo, opts.historicalFrom, new Date());
    const row = await getGarminIntegration(db, userId);
    await setIntegrationState(db, userId, { settings: { ...(row?.settings ?? {}), wellnessBackfillFrom: opts.historicalFrom } });
  }

  let result: TickResult;
  try {
    result = await runSyncTick({ repo, garmin, deadline }, { createIncremental: opts.createIncremental });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setIntegrationState(db, userId, { status: "error", last_error: msg, last_error_at: new Date().toISOString() });
    return { configured: true, error: msg };
  }

  if (result.authError) {
    await setIntegrationState(db, userId, { status: "needs_reauth", last_error: result.authError, last_error_at: new Date().toISOString() });
    return { configured: true, ...result };
  }
  await setIntegrationState(db, userId, { status: "connected", last_success_at: new Date().toISOString(), last_error: null });

  // Wellness: backfill after a historical import, otherwise refresh the last week every few hours.
  let wellness: UserTickOutcome["wellness"];
  if (result.done && Date.now() - started < opts.budgetMs * 0.5) {
    const row = await getGarminIntegration(db, userId);
    const settings = row?.settings ?? {};
    const last = settings.lastWellnessSyncAt ? Date.parse(settings.lastWellnessSyncAt) : 0;
    const today = isoDate(new Date());
    const from: string | null = settings.wellnessBackfillFrom ?? (Date.now() - last > WELLNESS_INTERVAL_MS ? isoDate(new Date(Date.now() - 7 * 86400_000)) : null);
    if (from) {
      try {
        wellness = await syncWellness(garmin, repo, from, today, deadline);
        await setIntegrationState(db, userId, {
          settings: {
            ...settings,
            // a partial backfill continues from where it stopped on the next tick
            wellnessBackfillFrom: wellness.resumeFrom,
            lastWellnessSyncAt: new Date().toISOString(),
            lastWellnessErrors: wellness.errors,
          },
        });
      } catch (e) {
        if (!(e instanceof GarminAuthError)) throw e;
      }
    }
  }
  return { configured: true, ...result, wellness };
}
