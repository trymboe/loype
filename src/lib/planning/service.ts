import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso, formatDay, weekStart } from "../dates";
import { fetchAll } from "../db/paginate";
import { trainingPaces } from "../analytics/fitness/vdot";
import { buildBaseline } from "./baseline";
import { generatePlan, raceLabelFor } from "./generator";
import { assessExecution, matchRuns } from "./match";
import { proposeAdaptations, type AdaptWorkout, type Change } from "./adapt";
import { buildWorkout, stepsDistance, stepsDuration, type TargetContext } from "./workouts";
import { editIssues, hardSeconds, rebuildSteps, titleFor, type EditableStep } from "./edit-steps";
import { PLANNER_VERSION, WORKOUT_LABEL, type Baseline, type Goal, type PlanConfig, type PlanWeek, type PlannedWorkout, type WorkoutType } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function loadBaseline(db: SupabaseClient, userId: string, asOf: string): Promise<Baseline> {
  const [{ data: state }, { data: acts }] = await Promise.all([
    db.from("fitness_state").select("output").eq("user_id", userId).maybeSingle(),
    db
      .from("activities")
      .select("local_date, moving_s, distance_m")
      .eq("user_id", userId)
      .eq("sport", "running")
      .is("duplicate_of", null)
      .gte("local_date", addDaysIso(asOf, -63))
      .lte("local_date", asOf),
  ]);
  const o = state?.output ?? null;
  return buildBaseline(
    asOf,
    o ? { estimate: o.estimate, paceZones: o.paceZones, hrZones: o.hrZones, threshold: o.threshold, predictions: o.predictions } : null,
    (acts ?? []).map((a: any) => ({ date: a.local_date, movingS: a.moving_s, distanceM: a.distance_m })),
  );
}

export const goalFromRow = (g: any): Goal => ({
  kind: g.kind,
  name: g.name,
  distanceM: g.distance_m,
  raceDate: g.race_date,
  targetTimeS: g.target_time_s,
  targetWeeklyKm: g.target_weekly_km,
});

const workoutRow = (w: PlannedWorkout, planId: string, userId: string, source = "generator") => ({
  plan_id: planId,
  user_id: userId,
  date: w.date,
  original_date: w.date,
  type: w.type,
  title: w.title,
  objective: w.objective,
  why: w.why,
  steps: w.steps,
  duration_s: Math.round(w.durationS),
  distance_m: w.distanceM,
  key: w.key,
  locked: false,
  source,
});

/** Creates a plan (archiving any active one, which keeps its history). */
export async function createPlan(db: SupabaseClient, userId: string, goal: Goal, config: PlanConfig, asOf: string, reason = "Plan created") {
  const baseline = await loadBaseline(db, userId, asOf);
  const plan = generatePlan(goal, config, baseline);
  const { data: old } = await db.from("training_plans").select("id, goal_id").eq("user_id", userId).eq("status", "active").maybeSingle();
  if (old) {
    await check(db.from("training_plans").update({ status: "archived" }).eq("id", old.id));
    await check(db.from("goals").update({ archived_at: new Date().toISOString() }).eq("id", old.goal_id));
  }
  const g = await single(
    db
      .from("goals")
      .insert({ user_id: userId, kind: goal.kind, name: goal.name, distance_m: goal.distanceM, race_date: goal.raceDate, target_time_s: goal.targetTimeS, target_weekly_km: goal.targetWeeklyKm })
      .select("id"),
  );
  const p = await single(
    db
      .from("training_plans")
      .insert({
        user_id: userId,
        goal_id: g.id,
        planner_version: PLANNER_VERSION,
        // the plan-start projection lives in config (jsonb), so no schema change is needed
        config: { ...plan.config, projection: plan.projection },
        baseline: plan.baseline,
        race_pace: plan.racePace,
        weeks: plan.weeks,
        summary: plan.summary,
        warnings: plan.warnings,
        current_version: 0,
      })
      .select("id"),
  );
  if (plan.workouts.length) await check(db.from("planned_workouts").insert(plan.workouts.map((w) => workoutRow(w, p.id, userId))));
  await snapshot(db, userId, p.id, old ? `${reason} (replaces the previous plan)` : reason, "generator");
  return p.id as string;
}

/** Stores the plan's current workouts as a new version. */
export async function snapshot(db: SupabaseClient, userId: string, planId: string, reason: string, by: "generator" | "athlete" | "adaptation") {
  const [{ data: plan }, { data: ws }] = await Promise.all([
    db.from("training_plans").select("current_version, baseline, race_pace").eq("id", planId).single(),
    db.from("planned_workouts").select("id, date, type, title, objective, why, steps, duration_s, distance_m, key, locked, status").eq("plan_id", planId).order("date"),
  ]);
  const version = (plan?.current_version ?? 0) + 1;
  await check(
    db.from("plan_versions").insert({
      plan_id: planId,
      user_id: userId,
      version,
      reason,
      created_by: by,
      snapshot: { workouts: ws ?? [], vdot: plan?.baseline?.vdot ?? null, racePace: plan?.race_pace ?? null },
    }),
  );
  await check(db.from("training_plans").update({ current_version: version }).eq("id", planId));
  return version;
}

export async function activePlan(db: SupabaseClient, userId: string) {
  const { data } = await db.from("training_plans").select("*, goal:goals(*)").eq("user_id", userId).eq("status", "active").maybeSingle();
  return data as any | null;
}

export function planContext(plan: any): TargetContext {
  return { baseline: plan.baseline as Baseline, racePace: plan.race_pace, raceLabel: raceLabelFor(goalFromRow(plan.goal)) };
}

/**
 * Keeps the plan in step with what actually happened: links new runs to
 * planned workouts, records execution, marks missed sessions, and creates
 * adaptation proposals. Never changes a workout by itself.
 */
export async function runPlanMaintenance(db: SupabaseClient, userId: string, today: string) {
  const plan = await activePlan(db, userId);
  if (!plan) return { status: "no_plan" as const };
  let ws = await fetchAll<any>((from, to) => db.from("planned_workouts").select("*").eq("plan_id", plan.id).order("date").range(from, to));
  if (!ws.length) return { status: "empty" as const };
  const start = ws[0].date as string;
  const from = addDaysIso(start < today ? start : today, -21);
  const { data: acts } = await db
    .from("activities")
    .select("id, local_date, moving_s, distance_m, avg_hr, classification_override")
    .eq("user_id", userId)
    .eq("sport", "running")
    .is("duplicate_of", null)
    .gte("local_date", from)
    .lte("local_date", today);
  const runs = acts ?? [];
  const ids = runs.map((r: any) => r.id);
  const [{ data: scores }, { data: fb }] = await Promise.all([
    ids.length ? db.from("activity_scores").select("activity_id, classification").in("activity_id", ids) : Promise.resolve({ data: [] as any[] }),
    ids.length ? db.from("workout_feedback").select("activity_id, rpe, legs").in("activity_id", ids) : Promise.resolve({ data: [] as any[] }),
  ]);
  const cls = new Map<string, string>((scores ?? []).map((s: any) => [s.activity_id, s.classification]));
  const feedback = new Map<string, { rpe: number | null; legs: string | null }>((fb ?? []).map((f: any) => [f.activity_id, { rpe: f.rpe, legs: f.legs }]));
  const classOf = (r: any) => r.classification_override ?? cls.get(r.id) ?? null;

  // 1. matching
  const result = matchRuns(
    ws.map((w) => ({ id: w.id, date: w.date, type: w.type, durationS: w.duration_s, status: w.status, activityId: w.activity_id })),
    runs.filter((r: any) => r.local_date >= start).map((r: any) => ({ id: r.id, date: r.local_date, movingS: r.moving_s, classification: classOf(r) })),
    today,
  );
  if (result.matches.length) {
    const { data: feats } = await db.from("activity_features").select("activity_id, features").in("activity_id", result.matches.map((m) => m.activityId));
    const featBy = new Map<string, any>((feats ?? []).map((f: any) => [f.activity_id, f.features]));
    for (const m of result.matches) {
      const w = ws.find((x) => x.id === m.workoutId)!;
      const r = runs.find((x: any) => x.id === m.activityId)!;
      const execution = assessExecution({ type: w.type, durationS: w.duration_s, steps: w.steps }, { movingS: r.moving_s, distanceM: r.distance_m, avgHr: r.avg_hr, features: featBy.get(r.id) ?? null });
      await check(db.from("planned_workouts").update({ status: "completed", activity_id: m.activityId, match_score: m.score, execution }).eq("id", w.id));
      Object.assign(w, { status: "completed", activity_id: m.activityId, execution });
    }
  }
  if (result.missed.length) {
    await check(db.from("planned_workouts").update({ status: "missed" }).in("id", result.missed));
    for (const w of ws) if (result.missed.includes(w.id)) w.status = "missed";
  }

  // 2. weekly refresh from what you actually ran
  if (await refreshFutureWeeks(db, userId, plan, today)) {
    ws = await fetchAll<any>((from, to) => db.from("planned_workouts").select("*").eq("plan_id", plan.id).order("date").range(from, to));
  }

  // 3. proposals
  const { data: state } = await db.from("fitness_state").select("output").eq("user_id", userId).maybeSingle();
  const est = state?.output?.estimate;
  const { data: existing } = await db.from("adaptation_proposals").select("id, key, status, changes").eq("plan_id", plan.id);
  // pending proposals that now touch the past are out of date
  const stale = (existing ?? []).filter((p: any) => p.status === "pending" && (p.changes as Change[]).some((c) => c.date < today)).map((p: any) => p.id);
  if (stale.length) await check(db.from("adaptation_proposals").update({ status: "superseded", decided_at: new Date().toISOString() }).in("id", stale));
  const ctx = planContext(plan);
  const proposals = proposeAdaptations({
    today,
    goal: goalFromRow(plan.goal),
    baseline: ctx.baseline,
    racePace: ctx.racePace,
    raceLabel: ctx.raceLabel,
    workouts: ws.map(toAdapt(feedback)),
    runs: runs.map((r: any) => ({ date: r.local_date, movingS: r.moving_s, classification: classOf(r), rpe: feedback.get(r.id)?.rpe ?? null, legs: feedback.get(r.id)?.legs ?? null })),
    fitness: est && !est.withheld ? { vdot: est.vdot, confidence: est.confidence } : null,
    existingKeys: new Set((existing ?? []).map((p: any) => p.key)),
  });
  if (proposals.length) {
    await check(
      db.from("adaptation_proposals").insert(
        proposals.map((p) => ({
          plan_id: plan.id,
          user_id: userId,
          rule: p.rule,
          key: p.key,
          title: p.title,
          explanation: p.explanation,
          evidence: p.evidence,
          changes: p.changes,
          baseline_patch: p.baselinePatch ?? null,
        })),
      ),
    );
  }
  return { status: "ok" as const, matched: result.matches.length, missed: result.missed.length, proposals: proposals.length };
}

/**
 * Once a week, recalculates the rest of the plan from your actual running:
 * the coming weeks start from what you really did (last week and your
 * 4-week average), so the plan grows when you handle more and backs off when
 * you do less. Phases and race date stay; workouts you locked, moved, swapped,
 * finished or skipped, and accepted adaptations, are kept. Versioned, so it
 * can be undone from History.
 */
export async function refreshFutureWeeks(db: SupabaseClient, userId: string, plan: any, today: string): Promise<boolean> {
  const thisWeek = weekStart(today);
  const weeks = plan.weeks as PlanWeek[];
  const idx = weeks.findIndex((w) => w.start === thisWeek);
  if (idx < 1 || plan.config?.refreshedWeek === thisWeek) return false;
  const remaining = weeks.slice(idx);
  const fresh = await loadBaseline(db, userId, today);
  const old = plan.baseline as Baseline;
  const baseline: Baseline = {
    ...old,
    asOf: fresh.asOf,
    weeklyMinutes: fresh.weeklyMinutes,
    weeklyKm: fresh.weeklyKm,
    runsPerWeek: fresh.runsPerWeek,
    consistency: fresh.consistency,
    longestRunMinutes: fresh.longestRunMinutes,
    longestRun30Minutes: fresh.longestRun30Minutes,
    recentWeeks: fresh.recentWeeks,
    recentRunCounts: fresh.recentRunCounts,
    habitualRunMinutes: fresh.habitualRunMinutes,
  };
  const goal = goalFromRow(plan.goal);
  const config: PlanConfig = { ...(plan.config as PlanConfig), startDate: today, weeks: remaining.length, phases: remaining.map((w) => w.phase) };
  const gen = generatePlan(goal, config, baseline);
  if (gen.weeks.length !== remaining.length || gen.weeks[0]?.start !== thisWeek) {
    await check(db.from("training_plans").update({ config: { ...plan.config, refreshedWeek: thisWeek } }).eq("id", plan.id));
    return false;
  }

  const { data: rows } = await db.from("planned_workouts").select("id, date, status, locked, source").eq("plan_id", plan.id).gte("date", today);
  const replaceable = (rows ?? []).filter((r: any) => r.status === "planned" && !r.locked && r.source === "generator");
  const keptDates = new Set((rows ?? []).filter((r: any) => !replaceable.includes(r)).map((r: any) => r.date));
  // never re-plan a day you already ran
  const { data: ran } = await db.from("activities").select("local_date").eq("user_id", userId).eq("sport", "running").is("duplicate_of", null).eq("local_date", today);
  if (ran?.length) keptDates.add(today);
  if (replaceable.length) await check(db.from("planned_workouts").delete().in("id", replaceable.map((r: any) => r.id)));
  const fresh_ = gen.workouts.filter((w) => !keptDates.has(w.date));
  if (fresh_.length) await check(db.from("planned_workouts").insert(fresh_.map((w) => workoutRow(w, plan.id, userId))));

  await check(
    db
      .from("training_plans")
      .update({
        weeks: [...weeks.slice(0, idx), ...gen.weeks.map((w, k) => ({ ...w, index: idx + k }))],
        config: { ...plan.config, refreshedWeek: thisWeek },
      })
      .eq("id", plan.id),
  );
  await check(db.from("adaptation_proposals").update({ status: "superseded", decided_at: new Date().toISOString() }).eq("plan_id", plan.id).eq("status", "pending"));
  const rw = fresh.recentWeeks ?? [];
  await snapshot(
    db,
    userId,
    plan.id,
    `Weekly update: the coming weeks were recalculated from your actual running (last week ${rw.at(-1) ?? 0} min, 4-week average ${fresh.weeklyMinutes} min). This week: ${gen.weeks[0].targetMinutes} min.`,
    "adaptation",
  );
  return true;
}

const toAdapt =
  (feedback: Map<string, { rpe: number | null; legs: string | null }>) =>
  (w: any): AdaptWorkout => ({
    id: w.id,
    date: w.date,
    type: w.type,
    title: w.title,
    objective: w.objective,
    why: w.why,
    steps: w.steps,
    durationS: w.duration_s,
    distanceM: w.distance_m,
    key: w.key,
    locked: w.locked,
    status: w.status,
    execution: w.execution,
    rpe: w.activity_id ? (feedback.get(w.activity_id)?.rpe ?? null) : null,
  });

const fieldsToRow = (f: Change["after"]) => ({
  type: f.type,
  title: f.title,
  objective: f.objective,
  why: f.why,
  steps: f.steps,
  duration_s: Math.round(f.durationS),
  distance_m: f.distanceM,
});

const same = (row: any, f: Change["after"]) => row.type === f.type && row.title === f.title && JSON.stringify(row.steps) === JSON.stringify(f.steps);

/** Accept: apply each change whose workout hasn't been edited since; reject: just record it. */
export async function decideProposal(db: SupabaseClient, userId: string, id: string, accept: boolean) {
  const p = await single(db.from("adaptation_proposals").select("*").eq("id", id).eq("user_id", userId));
  if (p.status !== "pending") return;
  if (!accept) {
    await check(db.from("adaptation_proposals").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", id));
    return;
  }
  const changes = p.changes as Change[];
  const { data: rows } = await db.from("planned_workouts").select("*").in("id", changes.map((c) => c.workoutId));
  let applied = 0;
  for (const c of changes) {
    const row = (rows ?? []).find((r: any) => r.id === c.workoutId);
    if (!row || row.status !== "planned" || row.locked || !same(row, c.before)) continue;
    await check(db.from("planned_workouts").update({ ...fieldsToRow(c.after), source: "adaptation" }).eq("id", c.workoutId));
    applied++;
  }
  let patch = p.baseline_patch;
  if (patch) {
    const { data: plan } = await db.from("training_plans").select("baseline, race_pace").eq("id", p.plan_id).single();
    patch = { ...patch, prev: { vdot: plan!.baseline.vdot, paceZones: plan!.baseline.paceZones, racePace: plan!.race_pace } };
    await check(
      db
        .from("training_plans")
        .update({ baseline: { ...plan!.baseline, vdot: patch.vdot, paceZones: trainingPaces(patch.vdot) }, race_pace: patch.racePace })
        .eq("id", p.plan_id),
    );
  }
  const version = await snapshot(db, userId, p.plan_id, `Accepted: ${p.title} (${applied} workout${applied === 1 ? "" : "s"} changed)`, "adaptation");
  await check(db.from("adaptation_proposals").update({ status: "accepted", decided_at: new Date().toISOString(), resulting_version: version, baseline_patch: patch }).eq("id", id));
}

export async function undoProposal(db: SupabaseClient, userId: string, id: string) {
  const p = await single(db.from("adaptation_proposals").select("*").eq("id", id).eq("user_id", userId));
  if (p.status !== "accepted") return;
  const changes = p.changes as Change[];
  const { data: rows } = await db.from("planned_workouts").select("*").in("id", changes.map((c) => c.workoutId));
  for (const c of changes) {
    const row = (rows ?? []).find((r: any) => r.id === c.workoutId);
    if (!row || row.status !== "planned" || !same(row, c.after)) continue;
    await check(db.from("planned_workouts").update({ ...fieldsToRow(c.before), source: "generator" }).eq("id", c.workoutId));
  }
  if (p.baseline_patch?.prev) {
    const { data: plan } = await db.from("training_plans").select("baseline").eq("id", p.plan_id).single();
    const prev = p.baseline_patch.prev;
    await check(db.from("training_plans").update({ baseline: { ...plan!.baseline, vdot: prev.vdot, paceZones: prev.paceZones }, race_pace: prev.racePace }).eq("id", p.plan_id));
  }
  await snapshot(db, userId, p.plan_id, `Undid: ${p.title}`, "athlete");
  await check(db.from("adaptation_proposals").update({ status: "undone", decided_at: new Date().toISOString() }).eq("id", id));
}

/** Restores every not-yet-done workout to how it was in an earlier version. */
export async function restoreVersion(db: SupabaseClient, userId: string, planId: string, version: number) {
  const v = await single(db.from("plan_versions").select("snapshot").eq("plan_id", planId).eq("user_id", userId).eq("version", version));
  const { data: rows } = await db.from("planned_workouts").select("id, status").eq("plan_id", planId);
  const open = new Set((rows ?? []).filter((r: any) => r.status === "planned" || r.status === "skipped").map((r: any) => r.id));
  for (const w of v.snapshot.workouts as any[]) {
    if (!open.has(w.id)) continue;
    await check(
      db
        .from("planned_workouts")
        .update({ date: w.date, type: w.type, title: w.title, objective: w.objective, why: w.why, steps: w.steps, duration_s: w.duration_s, distance_m: w.distance_m, locked: w.locked, status: w.status === "skipped" ? "skipped" : "planned" })
        .eq("id", w.id),
    );
  }
  await snapshot(db, userId, planId, `Restored version ${version}`, "athlete");
}

export type WorkoutEdit = { kind: "move"; date: string } | { kind: "lock"; locked: boolean } | { kind: "skip" } | { kind: "unskip" } | { kind: "swap"; to: "easy" | "rest" } | { kind: "steps"; steps: EditableStep[] };

export async function editWorkout(db: SupabaseClient, userId: string, id: string, edit: WorkoutEdit) {
  const w = await single(db.from("planned_workouts").select("*, plan:training_plans(*, goal:goals(*))").eq("id", id).eq("user_id", userId));
  const label = `${w.title} (${formatDay(w.date)})`;
  let update: Record<string, unknown> = {};
  let reason = "";
  switch (edit.kind) {
    case "move":
      update = { date: edit.date };
      reason = `Moved ${label} to ${formatDay(edit.date)}`;
      break;
    case "lock":
      update = { locked: edit.locked };
      reason = `${edit.locked ? "Locked" : "Unlocked"} ${label}`;
      break;
    case "skip":
      update = { status: "skipped" };
      reason = `Skipped ${label}`;
      break;
    case "unskip":
      update = { status: "planned" };
      reason = `Restored ${label}`;
      break;
    case "swap": {
      const ctx = planContext(w.plan);
      const minutes = Math.min(45, Math.max(20, Math.round(w.duration_s / 60 / 1.5)));
      const b = buildWorkout({ type: edit.to === "rest" ? "rest" : "easy", minutes }, ctx);
      update = {
        type: b.type as WorkoutType,
        title: b.title,
        objective: b.objective,
        why: edit.to === "rest" ? `You swapped ${WORKOUT_LABEL[w.type as WorkoutType].toLowerCase()} for rest.` : `You swapped ${WORKOUT_LABEL[w.type as WorkoutType].toLowerCase()} for an easy run.`,
        steps: b.steps,
        duration_s: stepsDuration(b.steps),
        distance_m: stepsDistance(b.steps),
        key: false,
        source: "athlete",
      };
      reason = `Swapped ${label} for ${edit.to === "rest" ? "rest" : "an easy run"}`;
      break;
    }
    case "steps": {
      const steps = rebuildSteps(edit.steps, planContext(w.plan));
      update = { steps, title: titleFor(w.type as WorkoutType, steps), duration_s: stepsDuration(steps), distance_m: stepsDistance(steps) };
      reason = `Edited the steps of ${label}`;
      break;
    }
  }
  if (edit.kind !== "lock") update.source = "athlete";
  await check(db.from("planned_workouts").update(update).eq("id", id));
  await snapshot(db, userId, w.plan_id, reason, "athlete");
  return w.plan_id as string;
}

async function check(q: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await q;
  if (error) throw new Error(error.message);
}

async function single(q: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Not found");
  return row;
}

/** Checks an edited workout against the planner's safety rules before saving. */
export async function checkStepEdit(db: SupabaseClient, userId: string, id: string, edited: EditableStep[]): Promise<string[]> {
  const w = await single(db.from("planned_workouts").select("*, plan:training_plans(*, goal:goals(*))").eq("id", id).eq("user_id", userId));
  const ctx = planContext(w.plan);
  const steps = rebuildSteps(edited, ctx);
  const from = addDaysIso(w.date, -30);
  const ws = weekStart(w.date);
  const [{ data: acts }, { data: planned }] = await Promise.all([
    db.from("activities").select("moving_s").eq("user_id", userId).eq("sport", "running").is("duplicate_of", null).gte("local_date", from).lt("local_date", w.date),
    db.from("planned_workouts").select("id, date, duration_s, steps, status").eq("plan_id", w.plan_id).gte("date", from < ws ? from : ws).lte("date", addDaysIso(ws, 6)),
  ]);
  const realMax = Math.max(0, ...(acts ?? []).map((a: any) => (a.moving_s ?? 0) / 60));
  const plannedMax = Math.max(0, ...(planned ?? []).filter((p: any) => p.id !== id && p.status === "planned" && p.date < w.date && p.date >= from).map((p: any) => p.duration_s / 60));
  const week = (planned ?? []).filter((p: any) => p.id !== id && p.date >= ws && p.status !== "skipped");
  return editIssues(w.type as WorkoutType, steps, {
    longest30Min: Math.max(realMax, plannedMax),
    weekOtherMin: week.reduce((a: number, p: any) => a + p.duration_s / 60, 0),
    weekOtherHardMin: week.reduce((a: number, p: any) => a + hardSeconds(p.steps ?? []) / 60, 0),
    ctx,
  });
}
