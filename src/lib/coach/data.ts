import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso } from "../dates";
import { fetchAll } from "../db/paginate";
import type { Step, WorkoutType } from "../planning/types";
import { renderSnapshot, weeklyTotals, type MetricPoint, type RunRow, type SnapshotInput, type WorkoutRow } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN_COLS = "id, local_date, name, distance_m, moving_s, avg_hr, max_hr, elevation_gain_m, is_indoor, usable_for_fitness, quality, classification_override";

/** Runs (not duplicates) between two local dates, newest first, with scores and feedback joined in. */
export async function loadRuns(db: SupabaseClient, userId: string, from: string, to: string, limit = 400): Promise<RunRow[]> {
  const { data, error } = await db
    .from("activities")
    .select(RUN_COLS)
    .eq("user_id", userId)
    .eq("sport", "running")
    .is("duplicate_of", null)
    .gte("local_date", from)
    .lte("local_date", to)
    .order("start_time", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const acts = data ?? [];
  if (!acts.length) return [];
  const ids = acts.map((a: any) => a.id);
  const [{ data: scores }, { data: fb }] = await Promise.all([
    db.from("activity_scores").select("activity_id, classification, ef, decoupling_pct, trimp").in("activity_id", ids),
    db.from("workout_feedback").select("activity_id, rpe, legs, notes, discomfort").in("activity_id", ids),
  ]);
  const sc = new Map<string, any>((scores ?? []).map((s: any) => [s.activity_id, s]));
  const fe = new Map<string, any>((fb ?? []).map((f: any) => [f.activity_id, f]));
  return acts.map((a: any) => {
    const s = sc.get(a.id);
    const f = fe.get(a.id);
    const flags = ((a.quality?.flags ?? []) as any[]).filter((x) => x.severity !== "info").map((x) => x.code as string);
    return {
      id: a.id,
      date: a.local_date,
      name: a.name,
      distanceM: a.distance_m,
      movingS: a.moving_s,
      avgHr: a.avg_hr,
      maxHr: a.max_hr,
      elevationGainM: a.elevation_gain_m,
      isIndoor: a.is_indoor,
      usableForFitness: a.usable_for_fitness,
      qualityIssues: flags,
      classification: a.classification_override ?? s?.classification ?? null,
      ef: s?.ef ?? null,
      decouplingPct: s?.decoupling_pct ?? null,
      trimp: s?.trimp ?? null,
      rpe: f?.rpe ?? null,
      legs: f?.legs ?? null,
      notes: [f?.discomfort ? `discomfort: ${f.discomfort}` : null, f?.notes].filter(Boolean).join("; ") || null,
    };
  });
}

export async function loadMetricHistory(db: SupabaseClient, userId: string, metrics: string[], modelVersion: string | null, from: string): Promise<Record<string, MetricPoint[]>> {
  if (!modelVersion || !metrics.length) return {};
  const rows = await fetchAll<any>((a, b) =>
    db
      .from("fitness_snapshots")
      .select("as_of, kind, metric, value, lower_bound, upper_bound, confidence")
      .eq("user_id", userId)
      .eq("model_version", modelVersion)
      .in("metric", metrics)
      .gte("as_of", from)
      .order("as_of")
      .order("metric")
      .order("kind")
      .range(a, b),
  );
  const out: Record<string, MetricPoint[]> = {};
  for (const r of rows) (out[r.metric] ??= []).push({ asOf: r.as_of, kind: r.kind, value: r.value, lower: r.lower_bound, upper: r.upper_bound, confidence: r.confidence });
  return out;
}

export const toWorkoutRow = (w: any): WorkoutRow => ({
  id: w.id,
  date: w.date,
  type: w.type as WorkoutType,
  title: w.title,
  durationS: w.duration_s,
  distanceM: w.distance_m,
  key: w.key,
  locked: w.locked,
  status: w.status,
  steps: (w.steps ?? []) as Step[],
  execution: w.execution ?? null,
  activityId: w.activity_id ?? null,
});

export async function loadActivePlan(db: SupabaseClient, userId: string) {
  const { data } = await db.from("training_plans").select("*, goal:goals(*)").eq("user_id", userId).eq("status", "active").maybeSingle();
  return data as any | null;
}

export async function loadPlanWorkouts(db: SupabaseClient, planId: string, from: string, to: string) {
  const { data, error } = await db.from("planned_workouts").select("*").eq("plan_id", planId).gte("date", from).lte("date", to).order("date");
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

/** Everything the coach sees at the start of a turn, rendered as text. */
export async function buildSnapshot(db: SupabaseClient, userId: string, today: string, timezone: string): Promise<string> {
  const [{ data: state }, plan, { count }, { data: first }, wellnessRes] = await Promise.all([
    db.from("fitness_state").select("model_version, computed_at, output").eq("user_id", userId).maybeSingle(),
    loadActivePlan(db, userId),
    db.from("activities").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("sport", "running").is("duplicate_of", null),
    db.from("activities").select("local_date").eq("user_id", userId).eq("sport", "running").is("duplicate_of", null).order("start_time").limit(1).maybeSingle(),
    db.from("wellness_daily").select("calendar_date, metric, value").eq("user_id", userId).gte("calendar_date", addDaysIso(today, -7)).order("calendar_date"),
  ]);
  const runs = await loadRuns(db, userId, addDaysIso(today, -7 * 12), today);
  const history = await loadMetricHistory(db, userId, ["vdot", "race_10k", "threshold_pace", "ctl"], state?.model_version ?? null, addDaysIso(today, -400));
  let workouts: WorkoutRow[] = [];
  let proposals: any[] = [];
  if (plan) {
    workouts = (await loadPlanWorkouts(db, plan.id, addDaysIso(today, -14), addDaysIso(today, 14))).map(toWorkoutRow);
    const { data } = await db.from("adaptation_proposals").select("title, status, created_at, rule").eq("plan_id", plan.id).order("created_at", { ascending: false }).limit(6);
    proposals = data ?? [];
  }
  const o = state?.output ?? null;
  const input: SnapshotInput = {
    today,
    timezone,
    profile: null,
    fitness: o && {
      asOf: o.asOf,
      estimate: o.estimate,
      threshold: o.threshold,
      paceZones: o.paceZones,
      hrZones: o.hrZones,
      predictions: o.predictions,
      physiology: o.physiology,
      load: o.load?.slice(-1) ?? [],
      rampRate: o.rampRate,
      efficiency: o.efficiency && { changePer30dPct: o.efficiency.changePer30dPct, points: o.efficiency.points ?? [], spanDays: o.efficiency.spanDays },
      longestRecentM: o.longestRecentM,
      bestEfforts: o.bestEfforts,
    },
    fitnessComputedAt: state?.computed_at ?? null,
    history,
    weeks: weeklyTotals(runs, today, 12),
    recentRuns: runs.slice(0, 12),
    totalRuns: count ?? 0,
    firstRunDate: first?.local_date ?? null,
    plan: plan && {
      goal: {
        kind: plan.goal.kind,
        name: plan.goal.name,
        distanceM: plan.goal.distance_m,
        raceDate: plan.goal.race_date,
        targetTimeS: plan.goal.target_time_s,
        targetWeeklyKm: plan.goal.target_weekly_km,
      },
      weeks: plan.weeks ?? [],
      vdot: plan.baseline?.vdot ?? null,
      racePace: plan.race_pace,
      createdAt: plan.created_at,
      warnings: plan.warnings ?? [],
      config: plan.config,
    },
    workouts,
    proposals,
    wellness: (wellnessRes.data ?? []).map((w: any) => ({ date: w.calendar_date, metric: w.metric, value: w.value })),
  };
  return renderSnapshot(input);
}
