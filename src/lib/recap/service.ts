import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso, weekStart } from "../dates";
import { activePlan, runPlanMaintenance } from "../planning/service";
import { raceGoalFromRow } from "../race/goal";
import { raceStatus } from "../race/status";
import { livePlanProjection } from "../race/projection";
import type { PlanWeek } from "../planning/types";
import { buildWeekRecap, snapshotFromHistory, snapshotFromModel, type EstimateSnapshot, type RaceSnap, type WeekRecap } from "./build";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WeeklyRecapRow {
  id: string;
  week_start: string;
  estimates: EstimateSnapshot;
  recap: WeekRecap;
  model_version: string | null;
  created_at: string;
  seen_at: string | null;
}

const COLS = "id, week_start, estimates, recap, model_version, created_at, seen_at";

/** Monday of the last finished week. */
export const reviewedWeek = (today: string) => addDaysIso(weekStart(today), -7);

/**
 * Makes sure the last finished week has a recap and an estimate snapshot.
 * Runs at most once per week per athlete (the row is unique per week), from
 * the scheduled sync and, as a fallback, from the first visit of the week.
 * Returns the row, or null when there is nothing to review (no runs in the
 * last 8 weeks and no plan).
 *
 * `maintain`: bring the plan up to date first (its weekly recalculation),
 * so the recap can say how it changed. The scheduled sync has just done this.
 */
export async function ensureWeeklyRecap(db: SupabaseClient, userId: string, today: string, opts: { maintain?: boolean } = {}): Promise<WeeklyRecapRow | null> {
  const ws = reviewedWeek(today);
  const { data: existing } = await db.from("weekly_recaps").select(COLS).eq("user_id", userId).eq("week_start", ws).maybeSingle();
  if (existing) return existing as WeeklyRecapRow;

  let plan = await activePlan(db, userId);
  if (opts.maintain && plan && plan.config?.refreshedWeek !== weekStart(today)) {
    try {
      await runPlanMaintenance(db, userId, today);
      plan = await activePlan(db, userId);
    } catch {
      // the recap still works from the plan as it is
    }
  }

  const we = addDaysIso(ws, 6);
  const from = addDaysIso(ws, -7 * 7);
  const { data: acts } = await db
    .from("activities")
    .select("id, local_date, moving_s, distance_m")
    .eq("user_id", userId)
    .eq("sport", "running")
    .is("duplicate_of", null)
    .gte("local_date", from)
    .lte("local_date", we);
  const runs = (acts ?? []) as any[];
  if (!runs.length && !plan) return null;

  const nextEnd = addDaysIso(ws, 13);
  const [{ data: fs }, { data: wos }, { data: versions }, { data: prevRow }] = await Promise.all([
    db.from("fitness_state").select("model_version, as_of, output").eq("user_id", userId).maybeSingle(),
    plan
      ? db.from("planned_workouts").select("date, type, title, status, key, duration_s, activity_id").eq("plan_id", plan.id).gte("date", ws).lte("date", nextEnd)
      : Promise.resolve({ data: [] as any[] }),
    plan
      ? db.from("plan_versions").select("version, reason, created_by, created_at").eq("plan_id", plan.id).gte("created_at", `${ws}T00:00:00Z`)
      : Promise.resolve({ data: [] as any[] }),
    db.from("weekly_recaps").select("week_start, estimates").eq("user_id", userId).lt("week_start", ws).order("week_start", { ascending: false }).limit(1).maybeSingle(),
  ]);

  // the goal race, predicted now and projected to race day
  const out = fs?.output ?? null;
  const goal = raceGoalFromRow(plan?.goal);
  let race: RaceSnap | null = null;
  if (goal) {
    const est = out?.estimate && !out.estimate.withheld ? out.estimate : null;
    const status = raceStatus({
      goal: { name: goal.name, distanceM: goal.distanceM, raceDate: goal.raceDate ?? today, targetTimeS: goal.targetTimeS },
      today,
      estimate: est ? { vdot: est.vdot, lower: est.lower, upper: est.upper, confidence: est.confidence } : null,
      longestRecentM: out?.longestRecentM ?? 0,
    });
    const proj = plan ? livePlanProjection(plan, out, ((wos ?? []) as any[]).map((w) => ({ date: w.date, status: w.status, type: w.type })), today) : null;
    race = {
      name: goal.name,
      distanceM: goal.distanceM,
      raceDate: goal.raceDate,
      targetTimeS: goal.targetTimeS,
      predictedS: status.prediction?.timeS ?? null,
      fastS: status.prediction?.fastS ?? null,
      slowS: status.prediction?.slowS ?? null,
      projectedS: proj?.projectedS ?? null,
      verdict: status.prediction ? status.verdict : null,
    };
  }
  const current = snapshotFromModel(out, fs?.model_version ?? null, race);

  // what to compare with: the previous recap, else the model's own history for the Sunday before the week
  let previous: EstimateSnapshot | null = null;
  let comparedWith: WeekRecap["comparedWith"] = null;
  if (prevRow) {
    previous = prevRow.estimates as EstimateSnapshot;
    comparedWith = { weekStart: prevRow.week_start, asOf: previous?.asOf ?? null, source: "recap" };
  } else if (fs?.model_version) {
    const asOf = addDaysIso(ws, -1);
    const { data: hist } = await db
      .from("fitness_snapshots")
      .select("metric, value, lower_bound, upper_bound, confidence")
      .eq("user_id", userId)
      .eq("kind", "retrospective")
      .eq("model_version", fs.model_version)
      .eq("as_of", asOf);
    previous = snapshotFromHistory((hist ?? []) as any[], asOf, fs.model_version);
    if (previous) comparedWith = { weekStart: weekStart(asOf), asOf, source: "history" };
  }

  const movingById = new Map<string, number | null>(runs.map((r) => [r.id, r.moving_s]));
  const toWorkout = (w: any) => ({
    date: w.date,
    type: w.type,
    title: w.title,
    status: w.status,
    key: !!w.key,
    durationS: w.duration_s ?? 0,
    actualS: w.activity_id ? (movingById.get(w.activity_id) ?? null) : null,
  });
  const all = (wos ?? []) as any[];
  const recap = buildWeekRecap({
    weekStart: ws,
    runs: runs.map((r) => ({ date: r.local_date, movingS: r.moving_s, distanceM: r.distance_m })),
    planWeeks: plan ? (plan.weeks as PlanWeek[]) : null,
    workouts: all.filter((w) => w.date <= we).map(toWorkout),
    nextWorkouts: all.filter((w) => w.date > we).map(toWorkout),
    versions: ((versions ?? []) as any[]).map((v) => ({ version: v.version, reason: v.reason, createdBy: v.created_by, createdAt: v.created_at })),
    current,
    previous,
    comparedWith,
  });

  const row = { user_id: userId, week_start: ws, estimates: current, recap, model_version: fs?.model_version ?? null };
  const { data: saved, error } = await db.from("weekly_recaps").insert(row).select(COLS).maybeSingle();
  if (saved) return saved as WeeklyRecapRow;
  // 23505: another request (the sync or a second tab) created it first
  if (error && (error as { code?: string }).code !== "23505") throw new Error(error.message);
  const { data: again } = await db.from("weekly_recaps").select(COLS).eq("user_id", userId).eq("week_start", ws).maybeSingle();
  return (again as WeeklyRecapRow | null) ?? null;
}

export async function markRecapSeen(db: SupabaseClient, userId: string, weekStartIso: string) {
  const { error } = await db.from("weekly_recaps").update({ seen_at: new Date().toISOString() }).eq("user_id", userId).eq("week_start", weekStartIso).is("seen_at", null);
  if (error) throw new Error(error.message);
}
