import "server-only";
import { fetchAll } from "./paginate";
import { createUserClient } from "./server";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ActivityListItem {
  id: string;
  name: string | null;
  start_time: string;
  local_date: string;
  utc_offset_s: number | null;
  sport: string;
  sub_sport: string | null;
  distance_m: number | null;
  moving_s: number | null;
  elapsed_s: number | null;
  avg_speed_moving: number | null;
  avg_hr: number | null;
  elevation_gain_m: number | null;
  is_indoor: boolean;
  quality_score: number | null;
  usable_for_fitness: boolean;
  route_preview: [number, number][] | null;
}

const LIST_COLS =
  "id, name, start_time, local_date, utc_offset_s, sport, sub_sport, distance_m, moving_s, elapsed_s, avg_speed_moving, avg_hr, elevation_gain_m, is_indoor, quality_score, usable_for_fitness, route_preview";

export async function listActivities(limit = 50, before?: string): Promise<ActivityListItem[]> {
  const db = await createUserClient();
  let q = db.from("activities").select(LIST_COLS).is("duplicate_of", null).order("start_time", { ascending: false }).limit(limit);
  if (before) q = q.lt("start_time", before);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ActivityListItem[];
}

export async function activitiesSince(isoDate: string): Promise<ActivityListItem[]> {
  const db = await createUserClient();
  return fetchAll<ActivityListItem>((from, to) =>
    db
      .from("activities")
      .select(LIST_COLS)
      .is("duplicate_of", null)
      .gte("local_date", isoDate)
      .order("start_time", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as any,
  );
}

export async function getActivityDetail(id: string) {
  const db = await createUserClient();
  const [act, streams, laps, splits, feedback] = await Promise.all([
    db.from("activities").select("*").eq("id", id).maybeSingle(),
    db.from("activity_streams").select("*").eq("activity_id", id).maybeSingle(),
    db.from("activity_laps").select("*").eq("activity_id", id).order("lap_index"),
    db.from("activity_splits").select("*").eq("activity_id", id).order("split_index"),
    db.from("workout_feedback").select("*").eq("activity_id", id).maybeSingle(),
  ]);
  if (act.error) throw new Error(act.error.message);
  if (!act.data) return null;
  return {
    activity: act.data as any,
    streams: streams.data as any,
    laps: (laps.data ?? []) as any[],
    splits: (splits.data ?? []) as any[],
    feedback: feedback.data as any,
  };
}

export async function getIntegrationStatus() {
  const db = await createUserClient();
  const { data } = await db
    .from("integrations")
    .select("status, last_success_at, last_error, last_error_at, api_key_expires_at, settings")
    .eq("provider", "garmin")
    .maybeSingle();
  return data as any | null;
}

export async function getActiveJob() {
  const db = await createUserClient();
  const { data } = await db
    .from("sync_jobs")
    .select("*")
    .in("status", ["queued", "discovering", "processing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as any | null;
}

export async function getFitnessState() {
  const db = await createUserClient();
  const { data } = await db.from("fitness_state").select("model_version, as_of, computed_at, output").maybeSingle();
  return data as { model_version: string; as_of: string; computed_at: string; output: any } | null;
}

/** Weekly VO2max-estimate history: retrospective rows, plus today's contemporaneous value. */
export async function getVdotHistory(modelVersion: string) {
  const db = await createUserClient();
  const { data, error } = await db
    .from("fitness_snapshots")
    .select("as_of, kind, value, lower_bound, upper_bound, confidence")
    .eq("metric", "vdot")
    .eq("model_version", modelVersion)
    .order("as_of");
  if (error) throw new Error(error.message);
  return (data ?? []) as { as_of: string; kind: string; value: number | null; lower_bound: number | null; upper_bound: number | null; confidence: string | null }[];
}

export async function getActivityScore(id: string) {
  const db = await createUserClient();
  const { data } = await db.from("activity_scores").select("*").eq("activity_id", id).maybeSingle();
  return data as any | null;
}

export async function getActivityFeatures(id: string) {
  const db = await createUserClient();
  const { data } = await db.from("activity_features").select("features").eq("activity_id", id).maybeSingle();
  return (data?.features ?? null) as any | null;
}
