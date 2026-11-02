import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso } from "../dates";
import { fetchAll } from "../db/paginate";
import { extractFeatures, FEATURES_VERSION, type RunFeatures } from "../analytics/fitness/features";
import { retrospectiveDates, runModel, snapshotsFrom, type ModelInput, type ModelOutput, type OtherActivity } from "../analytics/fitness/model";
import { MODEL_VERSION, type RunClass, type RunRecord } from "../analytics/fitness/scoring";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Weeks of retrospective snapshots kept for the trend charts. */
const RETRO_WEEKS = 52;
const STREAM_BATCH = 4;

export interface RecomputeResult {
  status: "up_to_date" | "computed" | "partial";
  featuresComputed: number;
  featuresPending: number;
}

/**
 * Brings the fitness model up to date for a user:
 *  1. extracts features for runs that don't have current ones (reads streams),
 *  2. re-runs the model when any input changed (fingerprint),
 *  3. writes scores, daily load, snapshots and the cached model output.
 * Safe to call often: it does nothing when inputs are unchanged.
 */
export async function recomputeFitness(db: SupabaseClient, userId: string, asOf: string, deadline = Date.now() + 40_000): Promise<RecomputeResult> {
  const acts = await fetchAll<any>((from, to) =>
    db
      .from("activities")
      .select("id, local_date, name, sport, distance_m, moving_s, avg_hr, quality, usable_for_fitness, is_indoor, classification_override")
      .eq("user_id", userId)
      .is("duplicate_of", null)
      .eq("sport", "running")
      .order("start_time")
      .range(from, to),
  );
  const feats = await fetchAll<any>((from, to) =>
    db.from("activity_features").select("activity_id, version, features").eq("user_id", userId).order("activity_id").range(from, to),
  );
  const featById = new Map<string, RunFeatures>(feats.filter((f) => f.version === FEATURES_VERSION).map((f) => [f.activity_id, f.features]));

  // 1. features
  const missing = acts.filter((a) => !featById.has(a.id));
  let computed = 0;
  for (let i = 0; i < missing.length && Date.now() < deadline; i += STREAM_BATCH) {
    const batch = missing.slice(i, i + STREAM_BATCH);
    const { data: streams, error } = await db
      .from("activity_streams")
      .select("activity_id, t, distance, hr, altitude, motion_states")
      .in("activity_id", batch.map((b) => b.id));
    if (error) throw new Error(error.message);
    const rows = (streams ?? []).map((s: any) => {
      const f = extractFeatures(s);
      featById.set(s.activity_id, f);
      return { activity_id: s.activity_id, user_id: userId, version: FEATURES_VERSION, features: f, computed_at: new Date().toISOString() };
    });
    if (rows.length) {
      const { error: e2 } = await db.from("activity_features").upsert(rows);
      if (e2) throw new Error(e2.message);
    }
    computed += rows.length;
  }
  const pending = acts.filter((a) => !featById.has(a.id)).length;

  // 2. inputs
  const [{ data: profile }, wellness, others] = await Promise.all([
    db.from("athlete_profile").select("max_hr, max_hr_source, resting_hr, resting_hr_source, birth_year, sex").eq("user_id", userId).maybeSingle(),
    fetchAll<any>((from, to) =>
      db
        .from("wellness_daily")
        .select("calendar_date, metric, value")
        .eq("user_id", userId)
        .in("metric", ["resting_hr", "sleep_avg_hr"])
        .gte("calendar_date", addDaysIso(asOf, -800))
        .order("calendar_date")
        .order("metric")
        .range(from, to),
    ),
    fetchAll<any>((from, to) =>
      db
        .from("raw_activity_sources")
        .select("id, activity_type, start_time, summary")
        .eq("user_id", userId)
        .eq("status", "skipped_type")
        .order("start_time")
        .range(from, to),
    ),
  ]);

  const runs: RunRecord[] = acts.map((a) => ({
    id: a.id,
    date: a.local_date,
    name: a.name,
    distanceM: a.distance_m,
    movingS: a.moving_s,
    avgHr: a.avg_hr,
    paceReliable: a.quality?.paceReliable ?? false,
    hrReliable: a.quality?.hrReliable ?? false,
    usableForFitness: a.usable_for_fitness,
    isIndoor: a.is_indoor,
    features: featById.get(a.id) ?? null,
    classificationOverride: (a.classification_override as RunClass | null) ?? null,
  }));
  const otherActs: OtherActivity[] = others
    .map((o) => {
      const s = o.summary ?? {};
      const local = typeof s.startTimeLocal === "string" ? s.startTimeLocal.slice(0, 10) : o.start_time?.slice(0, 10);
      return {
        id: o.id,
        date: local,
        type: o.activity_type ?? "other",
        durationS: num(s.duration) ?? num(s.elapsedDuration),
        avgHr: num(s.averageHR) ?? num(s.averageHeartRate),
      };
    })
    .filter((o) => o.date);
  const input: ModelInput = {
    asOf,
    profile: profile ?? null,
    runs,
    others: otherActs,
    wellness: wellness.map((w) => ({ date: w.calendar_date, metric: w.metric, value: w.value })),
  };

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ v: MODEL_VERSION, f: FEATURES_VERSION, asOf, profile, runs: runs.map((r) => [r.id, r.date, !!r.features, r.classificationOverride, r.usableForFitness]), w: wellness.length, wl: wellness.at(-1), o: otherActs.length }))
    .digest("hex");
  const { data: state } = await db.from("fitness_state").select("inputs_fingerprint").eq("user_id", userId).maybeSingle();
  if (state?.inputs_fingerprint === fingerprint && pending === 0) return { status: "up_to_date", featuresComputed: computed, featuresPending: 0 };

  // 3. model + writes
  const out = runModel(input);
  const now = new Date().toISOString();
  await upsertChunks(
    db,
    "activity_scores",
    out.scored.map(({ run, score }) => ({
      activity_id: run.id,
      user_id: userId,
      model_version: MODEL_VERSION,
      trimp: score.trimp,
      trimp_method: score.trimpMethod,
      intensity: score.intensity,
      intensity_source: score.intensitySource,
      ef: score.ef,
      decoupling_pct: score.decouplingPct,
      vo2max_from_hr: score.vo2maxFromHr,
      zone_seconds: score.zoneSeconds,
      classification: score.classification,
      classification_confidence: score.classificationConfidence,
      classification_reasons: score.classificationReasons,
      computed_at: now,
    })),
  );
  await upsertChunks(
    db,
    "daily_load",
    out.load.map((d) => ({ user_id: userId, date: d.date, run_trimp: d.run, other_trimp: d.other, ctl: d.ctl, atl: d.atl, tsb: d.tsb, model_version: MODEL_VERSION })),
  );

  const snapRows = (o: ModelOutput, kind: "contemporaneous" | "retrospective") =>
    snapshotsFrom(o).map((s) => ({
      user_id: userId,
      as_of: s.asOf,
      kind,
      metric: s.metric,
      value: s.value,
      lower_bound: s.lower,
      upper_bound: s.upper,
      confidence: s.confidence,
      model_version: MODEL_VERSION,
      evidence: s.evidence,
      computed_at: now,
    }));
  const retro = runs.length ? retrospectiveDates(runs[0].date, asOf, RETRO_WEEKS).flatMap((d) => snapRows(runModel({ ...input, asOf: d }), "retrospective")) : [];
  await upsertChunks(db, "fitness_snapshots", [...snapRows(out, "contemporaneous"), ...retro], "user_id,kind,as_of,metric,model_version");

  const { error } = await db.from("fitness_state").upsert({
    user_id: userId,
    model_version: MODEL_VERSION,
    as_of: asOf,
    inputs_fingerprint: pending ? "partial" : fingerprint,
    output: compactOutput(out),
    computed_at: now,
  });
  if (error) throw new Error(error.message);
  return { status: pending ? "partial" : "computed", featuresComputed: computed, featuresPending: pending };
}

/** What the pages need from the model output (per-run scores live in activity_scores). */
export type CompactOutput = Omit<ModelOutput, "scored" | "otherLoads" | "load"> & {
  load: ModelOutput["load"];
  otherLoadTotal: number;
  runCount: number;
};

function compactOutput(o: ModelOutput): CompactOutput {
  const { scored, otherLoads, load, ...rest } = o;
  return {
    ...rest,
    load: load.slice(-400),
    otherLoadTotal: otherLoads.length,
    runCount: scored.length,
  };
}

async function upsertChunks(db: SupabaseClient, table: string, rows: any[], onConflict?: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 500), onConflict ? { onConflict } : undefined);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
