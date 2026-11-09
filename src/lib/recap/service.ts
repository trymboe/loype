import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso, weekStart } from "../dates";
import { activePlan, runPlanMaintenance } from "../planning/service";
import { raceGoalFromRow } from "../race/goal";
import { predictRace, raceStatus } from "../race/status";
import { livePlanProjection } from "../race/projection";
import type { PlanWeek } from "../planning/types";
import { RECAP_VERSION, buildWeekRecap, snapshotFromHistory, snapshotFromModel, type EstimateSnapshot, type RaceSnap, type WeekRecap } from "./build";

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
 * so the plan and projection are current. The scheduled sync has just done this.
 * A recap stored in an older format is rebuilt (keeping its frozen estimates) and shown again.
 */
export async function ensureWeeklyRecap(db: SupabaseClient, userId: string, today: string, opts: { maintain?: boolean } = {}): Promise<WeeklyRecapRow | null> {
  try {
    await restateRecaps(db, userId);
  } catch {
    // restating history is best effort; the week's recap still works
  }
  return recapForWeek(db, userId, reviewedWeek(today), today, opts);
}

/**
 * When the fitness model changes method (a new model version), the estimates
 * frozen in earlier recaps are restated with the new model's retrospective
 * snapshot for the end of that week, so the history compares like with like.
 * Plan-related numbers (planned vs done, the plan projection) are kept; the
 * goal-race prediction is recomputed from the restated VDOT and the
 * projection shifted by the same amount. Waits until the model has finished
 * a full recompute (all runs have current features).
 */
export async function restateRecaps(db: SupabaseClient, userId: string): Promise<number> {
  const { data: fs } = await db.from("fitness_state").select("model_version, inputs_fingerprint").eq("user_id", userId).maybeSingle();
  const version = fs?.model_version as string | undefined;
  if (!version || fs?.inputs_fingerprint === "partial") return 0;
  const { data: stale } = await db.from("weekly_recaps").select(COLS).eq("user_id", userId).or(`model_version.is.null,model_version.neq.${version}`).order("week_start");
  let n = 0;
  for (const row of (stale ?? []) as WeeklyRecapRow[]) {
    const asOf = addDaysIso(row.week_start, 6);
    const { data: hist } = await db
      .from("fitness_snapshots")
      .select("metric, value, lower_bound, upper_bound, confidence")
      .eq("user_id", userId)
      .eq("kind", "retrospective")
      .eq("model_version", version)
      .eq("as_of", asOf);
    const snap = snapshotFromHistory((hist ?? []) as any[], asOf, version);
    if (!snap) continue;
    const estimates = restateEstimates(row.estimates, snap);
    const { error } = await db.from("weekly_recaps").update({ estimates, model_version: version }).eq("user_id", userId).eq("week_start", row.week_start);
    if (error) throw new Error(error.message);
    await recapForWeek(db, userId, row.week_start, asOf, { rebuild: true });
    n++;
  }
  return n;
}

/** The old snapshot with its model-derived numbers replaced by the restated ones. */
export function restateEstimates(old: EstimateSnapshot, snap: EstimateSnapshot): EstimateSnapshot {
  let race = old.race;
  if (race && snap.vdot) {
    const v = snap.vdot;
    const p = predictRace(race.distanceM, { vdot: v.value, lower: v.lower ?? v.value, upper: v.upper ?? v.value, confidence: v.confidence ?? "low" }, old.longestRecentM ?? 0);
    const shift = race.predictedS != null ? p.timeS - race.predictedS : 0;
    const projectedS = race.projectedS != null ? Math.round(race.projectedS + shift) : null;
    const t = race.targetTimeS;
    // same order as raceStatus; the stored projection has no range, so its point value stands in
    const verdict = !t ? "no_target" : p.timeS <= t ? "ahead" : p.fastS <= t ? "in_range" : projectedS != null && projectedS <= t ? "projected" : "stretch";
    race = {
      ...race,
      predictedS: p.timeS,
      fastS: p.fastS,
      slowS: p.slowS,
      projectedS,
      verdict,
    };
  }
  return {
    ...old,
    modelVersion: snap.modelVersion,
    vdot: snap.vdot,
    predictions: snap.predictions,
    thresholdPaceS: snap.thresholdPaceS,
    thresholdHr: snap.thresholdHr,
    efTrendPct: snap.efTrendPct ?? old.efTrendPct,
    race,
  };
}

async function recapForWeek(
  db: SupabaseClient,
  userId: string,
  ws: string,
  today: string,
  opts: { maintain?: boolean; rebuild?: boolean } = {},
): Promise<WeeklyRecapRow | null> {
  const { data: existing } = await db.from("weekly_recaps").select(COLS).eq("user_id", userId).eq("week_start", ws).maybeSingle();
  if (existing && !opts.rebuild && (existing as WeeklyRecapRow).recap?.version === RECAP_VERSION) return existing as WeeklyRecapRow;

  let plan = await activePlan(db, userId);
  if (!existing && opts.maintain && plan && plan.config?.refreshedWeek !== weekStart(today)) {
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
  if (!existing && !runs.length && !plan) return null;

  const [{ data: fs }, { data: wos }, { data: earlier }] = await Promise.all([
    db.from("fitness_state").select("model_version, as_of, output").eq("user_id", userId).maybeSingle(),
    plan
      ? db.from("planned_workouts").select("date, type, title, status, key, duration_s, activity_id").eq("plan_id", plan.id).gte("date", addDaysIso(ws, -28)).lte("date", we)
      : Promise.resolve({ data: [] as any[] }),
    db.from("weekly_recaps").select("week_start, estimates").eq("user_id", userId).lt("week_start", ws).order("week_start", { ascending: false }).limit(8),
  ]);
  const prevRow = ((earlier ?? []) as any[])[0] ?? null;

  // an older-format recap keeps the estimates it froze; only the review is rebuilt
  let current: EstimateSnapshot;
  if (existing) current = (existing as WeeklyRecapRow).estimates;
  else {
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
    current = snapshotFromModel(out, fs?.model_version ?? null, race);
  }

  // weekly model history (end of each week), for the first comparison and the race-time trend
  const modelVersion = current.modelVersion ?? fs?.model_version ?? null;
  const { data: hist } = modelVersion
    ? await db
        .from("fitness_snapshots")
        .select("as_of, metric, value, lower_bound, upper_bound, confidence")
        .eq("user_id", userId)
        .eq("kind", "retrospective")
        .eq("model_version", modelVersion)
        .gte("as_of", addDaysIso(ws, -50))
        .lte("as_of", we)
    : { data: [] as any[] };
  const histRows = (hist ?? []) as any[];

  // what to compare with: the previous recap, else the model's own history for the Sunday before the week
  let previous: EstimateSnapshot | null = null;
  let comparedWith: WeekRecap["comparedWith"] = null;
  if (prevRow) {
    previous = prevRow.estimates as EstimateSnapshot;
    comparedWith = { weekStart: prevRow.week_start, asOf: previous?.asOf ?? null, source: "recap" };
  } else if (modelVersion) {
    const asOf = addDaysIso(ws, -1);
    previous = snapshotFromHistory(histRows.filter((h) => h.as_of === asOf), asOf, modelVersion);
    if (previous) comparedWith = { weekStart: weekStart(asOf), asOf, source: "history" };
  }

  // predicted race time week by week: saved recaps first, else the model history
  const raceTrend: { weekStart: string; timeS: number }[] = [];
  const race = current.race;
  if (race) {
    const byWeek = new Map<string, number>();
    const key = Object.entries({ "5k": 5000, "10k": 10_000, half: 21_097.5, marathon: 42_195 }).find(([, d]) => Math.abs(d - race.distanceM) < 1)?.[0];
    const longest = current.longestRecentM ?? 0;
    for (const h of histRows) {
      if (h.value == null) continue;
      const w = weekStart(h.as_of);
      if (key && h.metric === `race_${key}`) byWeek.set(w, h.value);
      else if (!key && h.metric === "vdot" && !byWeek.has(w)) byWeek.set(w, predictRace(race.distanceM, { vdot: h.value, lower: h.value, upper: h.value, confidence: "low" }, longest).timeS);
    }
    for (const e of (earlier ?? []) as any[]) {
      const r = (e.estimates as EstimateSnapshot)?.race;
      if (r?.predictedS && Math.abs(r.distanceM - race.distanceM) < 1) byWeek.set(e.week_start, r.predictedS);
    }
    if (race.predictedS) byWeek.set(ws, race.predictedS);
    for (const [w, t] of byWeek) raceTrend.push({ weekStart: w, timeS: Math.round(t) });
  }

  const movingById = new Map<string, number | null>(runs.map((r) => [r.id, r.moving_s]));
  const recap = buildWeekRecap({
    weekStart: ws,
    runs: runs.map((r) => ({ date: r.local_date, movingS: r.moving_s, distanceM: r.distance_m })),
    planWeeks: plan ? (plan.weeks as PlanWeek[]) : null,
    workouts: ((wos ?? []) as any[])
      .filter((w) => w.date >= ws)
      .map((w) => ({
        date: w.date,
        type: w.type,
        title: w.title,
        status: w.status,
        key: !!w.key,
        durationS: w.duration_s ?? 0,
        actualS: w.activity_id ? (movingById.get(w.activity_id) ?? null) : null,
      })),
    raceTrend,
    current,
    previous,
    comparedWith,
  });

  if (existing) {
    // a new format is shown once more; a restated one keeps its seen state
    const seen_at = opts.rebuild ? (existing as WeeklyRecapRow).seen_at : null;
    const { error } = await db.from("weekly_recaps").update({ recap, seen_at }).eq("user_id", userId).eq("week_start", ws);
    if (error) throw new Error(error.message);
    return { ...(existing as WeeklyRecapRow), recap, seen_at };
  }
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
