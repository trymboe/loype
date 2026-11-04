/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Outbound workout sync: planned workouts → Intervals.icu (→ Garmin Connect → watch).
 *
 * Independent of the Garmin import: its own integration row, its own errors,
 * and every call is wrapped so a failure here never breaks activity sync.
 *
 * Honest states: an HTTP 200 only means Intervals.icu accepted the request.
 * We then compare Intervals.icu's parsed steps with what we sent ("parsed").
 * Neither proves the workout reached the watch; only the athlete can confirm
 * that ("on_watch"), because Intervals.icu exposes no Garmin delivery status.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, fingerprint } from "../crypto/secretbox";
import { fetchAll } from "../db/paginate";
import { checkParsed, type AthleteRunSettings } from "../integrations/intervals/encode";
import { IntervalsAuthError, IntervalsClient, type AthleteInfo, type RemoteEvent } from "../integrations/intervals/client";
import { DEFAULT_WINDOW_DAYS, planOutbound, type OutboundWorkout, type SyncRow } from "./plan";

export const PROVIDER = "intervals_icu";

export interface IntervalsSettings {
  athleteId?: string;
  athleteName?: string | null;
  windowDays?: number;
  run?: AthleteRunSettings & { thresholdPaceSPerKm: number | null };
  runCheckedAt?: string;
  lastPushAt?: string;
  lastPushSummary?: { sent: number; removed: number; unchanged: number; failed: number };
}

export async function getIntervalsIntegration(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("integrations").select("*").eq("user_id", userId).eq("provider", PROVIDER).maybeSingle();
  if (error) throw new Error(error.message);
  return data as any | null;
}

async function patchIntegration(db: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  await db.from("integrations").update(patch).eq("user_id", userId).eq("provider", PROVIDER);
}

export function clientFor(row: any, fetchImpl?: typeof fetch): IntervalsClient | null {
  if (!row?.api_key_ciphertext) return null;
  return new IntervalsClient({ apiKey: decryptSecret(row.api_key_ciphertext), athleteId: row.settings?.athleteId, fetchImpl });
}

/** Saves the key encrypted and verifies it by reading the athlete record. */
export async function connectIntervals(db: SupabaseClient, userId: string, apiKey: string, athleteId: string | null, fetchImpl?: typeof fetch): Promise<AthleteInfo> {
  const client = new IntervalsClient({ apiKey, athleteId: athleteId ?? undefined, fetchImpl });
  const athlete = await client.getAthlete(); // throws IntervalsAuthError on a bad key
  const existing = await getIntervalsIntegration(db, userId);
  const settings: IntervalsSettings = {
    ...(existing?.settings ?? {}),
    athleteId: athleteId || undefined,
    athleteName: athlete.name,
    run: athlete.run,
    runCheckedAt: new Date().toISOString(),
  };
  const row = {
    user_id: userId,
    provider: PROVIDER,
    api_key_ciphertext: encryptSecret(apiKey),
    api_key_fingerprint: fingerprint(apiKey),
    status: "connected",
    last_error: null,
    last_error_at: null,
    settings,
  };
  const { error } = existing
    ? await db.from("integrations").update(row).eq("id", existing.id)
    : await db.from("integrations").insert(row);
  if (error) throw new Error(error.message);
  return athlete;
}

/** Løype's latest threshold pace (s/km) and HR estimates, from the fitness model. */
export async function loypeThresholds(db: SupabaseClient, userId: string): Promise<{ paceSPerKm: number | null; hr: number | null }> {
  const latest = async (metric: string) => {
    const { data } = await db.from("fitness_snapshots").select("value").eq("user_id", userId).eq("metric", metric).eq("kind", "contemporaneous").order("as_of", { ascending: false }).limit(1).maybeSingle();
    return typeof data?.value === "number" ? data.value : null;
  };
  const [paceSPerKm, hr] = await Promise.all([latest("threshold_pace"), latest("threshold_hr")]);
  return { paceSPerKm, hr };
}

/** Writes Løype's threshold pace (and LTHR if missing) to Intervals.icu's Run settings, then resends the plan with pace targets. */
export async function applyThresholdsToIntervals(db: SupabaseClient, userId: string, today: string, fetchImpl?: typeof fetch): Promise<{ paceSPerKm: number; push: PushResult }> {
  const integration = await getIntervalsIntegration(db, userId);
  const client = clientFor(integration, fetchImpl);
  if (!client) throw new Error("Intervals.icu isn't connected");
  const t = await loypeThresholds(db, userId);
  if (!t.paceSPerKm) throw new Error("Løype has no threshold pace estimate yet");
  const athlete = await client.setRunThresholds(t.paceSPerKm, t.hr);
  await patchIntegration(db, userId, { settings: { ...(integration.settings ?? {}), run: athlete.run, runCheckedAt: new Date().toISOString() } });
  const push = await pushPlannedWorkouts(db, userId, today, { force: true, fetchImpl });
  return { paceSPerKm: t.paceSPerKm, push };
}

export async function disconnectIntervals(db: SupabaseClient, userId: string) {
  await patchIntegration(db, userId, { api_key_ciphertext: null, api_key_fingerprint: null, status: "not_configured", last_error: null });
}

export interface PushResult {
  configured: boolean;
  sent: number;
  removed: number;
  unchanged: number;
  failed: number;
  authError?: boolean;
  error?: string;
}

const RUN_RECHECK_MS = 6 * 3600_000;
/** Without a threshold pace, workouts go out with HR targets: look again soon so pace targets follow quickly once it's set. */
const RUN_RECHECK_NO_PACE_MS = 10 * 60_000;

/**
 * Brings Intervals.icu in line with the upcoming plan. Cheap when nothing
 * changed (one DB read, no API calls besides an occasional settings refresh).
 */
export async function pushPlannedWorkouts(db: SupabaseClient, userId: string, today: string, opts: { force?: boolean; onlyWorkoutId?: string; fetchImpl?: typeof fetch } = {}): Promise<PushResult> {
  const integration = await getIntervalsIntegration(db, userId);
  const client = clientFor(integration, opts.fetchImpl);
  const empty = { sent: 0, removed: 0, unchanged: 0, failed: 0 };
  if (!client || integration.status === "not_configured") return { configured: false, ...empty };
  const settings: IntervalsSettings = integration.settings ?? {};

  try {
    // Refresh threshold pace / max HR now and then: they decide how targets are encoded.
    let run = settings.run;
    if (!run || !settings.runCheckedAt || Date.now() - Date.parse(settings.runCheckedAt) > (run.hasThresholdPace ? RUN_RECHECK_MS : RUN_RECHECK_NO_PACE_MS) || opts.force) {
      const athlete = await client.getAthlete();
      run = athlete.run;
      settings.run = run;
      settings.athleteName = athlete.name;
      settings.runCheckedAt = new Date().toISOString();
    }

    const { workouts, rows } = await loadState(db, userId, today);
    const plan = planOutbound({
      today,
      // a manual send of one workout ignores the look-ahead window
      windowDays: opts.onlyWorkoutId ? 3650 : (settings.windowDays ?? DEFAULT_WINDOW_DAYS),
      workouts: opts.onlyWorkoutId ? workouts.filter((w) => w.id === opts.onlyWorkoutId) : workouts,
      rows: opts.onlyWorkoutId ? rows.filter((r) => r.planned_workout_id === opts.onlyWorkoutId) : rows,
      athlete: run!,
      force: opts.force,
    });

    let failed = 0;
    if (plan.deletes.length) {
      await client.deleteEvents(plan.deletes.map((r) => r.external_id));
      await db.from("external_workout_syncs").update({ state: "removed", last_error: null, last_sent_at: new Date().toISOString() }).in("id", plan.deletes.map((r) => r.id));
    }

    for (const u of plan.upserts) {
      const base = {
        user_id: userId,
        provider: PROVIDER,
        planned_workout_id: u.workout.id,
        external_id: u.event.external_id,
        workout_date: u.workout.date,
      };
      try {
        // Intervals.icu only re-exports a workout to Garmin when the event is created, not when
        // it's updated in place, so a changed workout is deleted and created again.
        if (u.row && u.row.state !== "removed") await client.deleteEvents([u.event.external_id]);
        const [remote] = await client.upsertEvents([u.event]);
        const check = remote?.workout_doc !== undefined ? checkParsed(u.workout.steps, u.mode, run!, remote.workout_doc as any) : null;
        const contentChanged = u.row?.payload_hash !== u.hash;
        await upsertRow(db, {
          ...base,
          remote_id: remote?.id != null ? String(remote.id) : null,
          payload_hash: u.hash,
          target_mode: u.mode,
          state: check ? (check.ok ? (u.row?.state === "on_watch" && !contentChanged ? "on_watch" : "parsed") : "mismatch") : "sent",
          parse_check: check,
          last_error: null,
          last_sent_at: new Date().toISOString(),
          last_checked_at: check ? new Date().toISOString() : null,
          // a changed workout has to be confirmed on the watch again
          ...(contentChanged ? { confirmed_on_watch_at: null } : {}),
        });
      } catch (e) {
        if (e instanceof IntervalsAuthError) throw e;
        failed++;
        await upsertRow(db, { ...base, state: "failed", last_error: e instanceof Error ? e.message : String(e) });
      }
    }

    const summary = { sent: plan.upserts.length - failed, removed: plan.deletes.length, unchanged: plan.unchanged, failed };
    await patchIntegration(db, userId, {
      status: failed ? "error" : "connected",
      last_success_at: new Date().toISOString(),
      last_error: failed ? `${failed} workout${failed > 1 ? "s" : ""} couldn't be sent` : null,
      ...(failed ? { last_error_at: new Date().toISOString() } : {}),
      settings: { ...settings, lastPushAt: new Date().toISOString(), lastPushSummary: summary },
    });
    return { configured: true, ...summary };
  } catch (e) {
    const auth = e instanceof IntervalsAuthError;
    const msg = auth ? "Intervals.icu rejected the API key. Paste a new one under More → Integrations." : e instanceof Error ? e.message : String(e);
    await patchIntegration(db, userId, { status: auth ? "needs_reauth" : "error", last_error: msg, last_error_at: new Date().toISOString(), settings });
    return { configured: true, ...empty, authError: auth || undefined, error: msg };
  }
}

async function upsertRow(db: SupabaseClient, row: Record<string, unknown>) {
  const { error } = await db.from("external_workout_syncs").upsert(row, { onConflict: "user_id,provider,external_id" });
  if (error) throw new Error(error.message);
}

async function loadState(db: SupabaseClient, userId: string, today: string): Promise<{ workouts: OutboundWorkout[]; rows: SyncRow[] }> {
  const [{ data: plans }, workoutsRaw, rows] = await Promise.all([
    db.from("training_plans").select("id").eq("user_id", userId).eq("status", "active"),
    fetchAll<any>((from, to) =>
      db.from("planned_workouts").select("id, plan_id, date, type, title, objective, steps, duration_s, status").eq("user_id", userId).gte("date", today).order("date").range(from, to),
    ),
    fetchAll<SyncRow>((from, to) =>
      db.from("external_workout_syncs").select("id, planned_workout_id, external_id, workout_date, payload_hash, state").eq("user_id", userId).eq("provider", PROVIDER).range(from, to),
    ),
  ]);
  const active = new Set((plans ?? []).map((p: any) => p.id));
  const workouts: OutboundWorkout[] = workoutsRaw.map((w: any) => ({
    id: w.id,
    date: w.date,
    type: w.type,
    title: w.title,
    objective: w.objective ?? "",
    steps: Array.isArray(w.steps) ? w.steps : [],
    duration_s: w.duration_s ?? 0,
    status: w.status,
    active: active.has(w.plan_id),
  }));
  return { workouts, rows };
}

/** Athlete-confirmed delivery: the only state that claims the workout is on the watch. */
export async function confirmOnWatch(db: SupabaseClient, userId: string, plannedWorkoutId: string, confirmed: boolean) {
  const { data } = await db.from("external_workout_syncs").select("id, state, parse_check").eq("user_id", userId).eq("planned_workout_id", plannedWorkoutId).eq("provider", PROVIDER).maybeSingle();
  if (!data) return false;
  if (confirmed && data.state === "removed") return false;
  const state = confirmed ? "on_watch" : data.parse_check?.ok ? "parsed" : data.parse_check ? "mismatch" : "sent";
  await db.from("external_workout_syncs").update({ state, confirmed_on_watch_at: confirmed ? new Date().toISOString() : null }).eq("id", data.id);
  return true;
}

export type { RemoteEvent };
