/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { addDaysIso, daysBetween } from "@/lib/dates";
import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { buildBaseline, type BaselineFitness, type BaselineRun } from "@/lib/planning/baseline";
import { generatePlan } from "@/lib/planning/generator";
import { buildWorkout, finalize } from "@/lib/planning/workouts";
import { isHard, type Goal, type PlanConfig } from "@/lib/planning/types";

vi.mock("server-only", () => ({}));
const { addTimeTrial, easeAroundTimeTrials, refreshFutureWeeks, activePlan, TimeTrialRefused } = await import("@/lib/planning/service");

const START = "2026-11-02"; // a Monday

const fitness = (vdot: number): BaselineFitness => ({
  estimate: { withheld: false, vdot, lower: vdot - 2, upper: vdot + 2, confidence: "medium" },
  paceZones: trainingPaces(vdot),
  hrZones: null,
  threshold: null,
  predictions: [5000, 10000, 21097.5, 42195].map((d) => ({ distanceM: d, timeS: predictTimeS(vdot, d) })),
});

/** 8 weeks before the plan: runs on Tue/Thu/Sat of `km` and a Sunday long run of `longKm`, at `pace` s/km. */
function history(km: number, longKm: number, pace: number): BaselineRun[] {
  const runs: BaselineRun[] = [];
  for (let w = 1; w <= 8; w++) {
    const s = addDaysIso(START, -7 * w);
    for (const d of [1, 3, 5]) runs.push({ date: addDaysIso(s, d), distanceM: km * 1000, movingS: km * pace });
    runs.push({ date: addDaysIso(s, 6), distanceM: longKm * 1000, movingS: longKm * pace });
  }
  return runs;
}

const goal: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-02-14", targetTimeS: null, targetWeeklyKm: null };
const config: PlanConfig = { startDate: START, weeks: 15, runDays: [1, 3, 5, 6], runsPerWeek: 4, longRunDay: 6, unavailableDays: [], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: false, baselineTimeTrial: false };

/** An active plan made without a time trial, with everything before `today` run as planned. */
function setup(today: string, runs = history(8, 14, 360)) {
  const f = fitness(45);
  const baseline = buildBaseline(addDaysIso(START, -1), f, runs);
  const gen = generatePlan(goal, config, baseline);
  const db = new FakeDb({
    goals: [{ id: "g", user_id: "u", kind: goal.kind, name: null, distance_m: null, race_date: goal.raceDate, target_time_s: null, target_weekly_km: null }],
    training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", race_pace: gen.racePace, current_version: 1, config: gen.config, baseline: gen.baseline, weeks: gen.weeks, summary: gen.summary, warnings: [] }],
    planned_workouts: gen.workouts.map((w, i) => ({
      id: `w${i}`, plan_id: "p", user_id: "u", date: w.date, original_date: w.date, type: w.type, title: w.title, objective: w.objective, why: w.why, steps: w.steps,
      duration_s: Math.round(w.durationS), distance_m: w.distanceM, key: w.key, locked: false, source: "generator", status: w.date < today ? "completed" : "planned",
    })),
    plan_versions: [],
    adaptation_proposals: [],
    fitness_state: [{ user_id: "u", output: { estimate: f.estimate, paceZones: f.paceZones, hrZones: null, threshold: null, predictions: f.predictions } }],
    activities: [
      ...runs.map((r, i) => ({ id: `a${i}`, user_id: "u", sport: "running", duplicate_of: null, local_date: r.date, moving_s: r.movingS, distance_m: r.distanceM, elevation_gain_m: 20 })),
      // the plan's runs so far, as planned
      ...gen.workouts.filter((w) => w.date < today).map((w, i) => ({ id: `p${i}`, user_id: "u", sport: "running", duplicate_of: null, local_date: w.date, moving_s: Math.round(w.durationS), distance_m: w.distanceM, elevation_gain_m: 20 })),
    ],
    activity_scores: [],
  });
  return { db, gen };
}

const rows = (db: FakeDb) => db.rows("planned_workouts");
const tts = (db: FakeDb) => rows(db).filter((w) => w.type === "time_trial");
const spacing = (db: FakeDb, tt: any) =>
  Math.min(7, ...rows(db).filter((o) => o.id !== tt.id && o.status !== "skipped" && (isHard(o.type) || o.type === "long" || o.type === "progressive_long")).map((o) => Math.abs(daysBetween(tt.date, o.date))));

describe("adding a time trial to a plan", () => {
  it("picks a planned run in the next 7 days, clear of the long run and hard sessions, in place of a hard session", async () => {
    const today = "2026-11-10";
    const { db } = setup(today);
    const before = rows(db).length;
    const r = await addTimeTrial(db as any, "u", today);
    const [tt] = tts(db);
    expect(tts(db)).toHaveLength(1);
    expect(rows(db)).toHaveLength(before); // it replaced a session, it didn't add one
    expect(tt.id).toBe(r.id);
    expect(tt.date >= today && tt.date <= addDaysIso(today, 6)).toBe(true);
    expect(spacing(db, tt)).toBeGreaterThanOrEqual(2);
    // Thursday's hills session becomes the time trial (replacing a hard session adds no load)
    expect(tt.date).toBe("2026-11-12");
    expect(r.replaced).toContain("hills");
    expect(tt).toMatchObject({ status: "planned", source: "athlete", key: true, title: "Time trial: 5 km" });
    const main = tt.steps.find((s: any) => s.distanceM);
    expect(main.distanceM).toBe(5000);
    expect(main.target.paceFast).toBeGreaterThan(0);
    // recorded as a plan version
    expect(db.rows("plan_versions").at(-1)!.reason).toContain("Added a time trial");
    expect(db.rows("training_plans")[0].current_version).toBe(2);
  });

  it("refuses a second one while one is still to come", async () => {
    const today = "2026-11-10";
    const { db } = setup(today);
    await addTimeTrial(db as any, "u", today);
    await expect(addTimeTrial(db as any, "u", today)).rejects.toThrow(/already has a time trial/);
    expect(tts(db)).toHaveLength(1);
  });

  it("is kept, once, by the weekly update, with no hard session next to it", async () => {
    const { db } = setup("2026-11-14");
    await addTimeTrial(db as any, "u", "2026-11-14");
    const [tt] = tts(db);
    expect(tt.date).toBe("2026-11-19"); // next week's Thursday tempo
    const monday = "2026-11-16";
    const refreshed = await refreshFutureWeeks(db as any, "u", await activePlan(db as any, "u"), monday);
    expect(refreshed).toBe(true);
    expect(tts(db)).toHaveLength(1);
    expect(tts(db)[0]).toMatchObject({ id: tt.id, date: "2026-11-19", status: "planned" });
    expect(spacing(db, tts(db)[0])).toBeGreaterThanOrEqual(2);
    // the time trial is that week's hard session
    expect(rows(db).filter((w) => w.date >= monday && w.date <= "2026-11-22" && isHard(w.type) && w.type !== "time_trial")).toHaveLength(0);
    // and later weeks still have their usual sessions
    expect(rows(db).some((w) => w.date > "2026-11-22" && isHard(w.type))).toBe(true);
  });

  it("on a chosen day next to a hard session: refuses unless allowed, then eases the day after", async () => {
    const today = "2026-11-10";
    const { db } = setup(today);
    const wed = { ...rows(db).find((w) => w.date === "2026-11-12")!, id: "wed", date: "2026-11-11", original_date: "2026-11-11" };
    rows(db).push(wed);
    const err = await addTimeTrial(db as any, "u", today, { date: today }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeTrialRefused);
    expect(err.overridable).toBe(true);
    expect(tts(db)).toHaveLength(0);
    const r = await addTimeTrial(db as any, "u", today, { date: today, allowClose: true });
    expect(r.date).toBe(today);
    expect(rows(db).find((w) => w.id === "wed")!.type).toBe("recovery");
    expect(r.eased).toContain("hills");
  });

  it("refuses when even a 3 km trial would be more than 10 % over the biggest recent run", async () => {
    const today = "2026-11-10";
    const { db } = setup(today, history(2.5, 3, 360));
    // every run so far and to come is a short easy run
    for (const w of rows(db)) Object.assign(w, { type: "easy", title: "20 min easy", duration_s: 1200, distance_m: 3300 });
    for (const a of db.rows("activities")) Object.assign(a, { moving_s: 900, distance_m: 2500 });
    await expect(addTimeTrial(db as any, "u", today)).rejects.toThrow(/10 %/);
    expect(tts(db)).toHaveLength(0);
    expect(db.rows("plan_versions")).toHaveLength(0);
  });

  it("uses 3 km for a 5 km goal", async () => {
    const today = "2026-11-10";
    const { db } = setup(today);
    db.rows("goals")[0].kind = "5k";
    await addTimeTrial(db as any, "u", today);
    expect(tts(db)[0].title).toBe("Time trial: 3 km");
  });

  it("a recalculated week makes room for a kept time trial", () => {
    const ctx = { baseline: buildBaseline("2026-11-01", fitness(45), history(8, 14, 360)), racePace: null, raceLabel: null };
    const w = (date: string, type: any) => finalize(buildWorkout({ type, minutes: 45, progress: 0.5 }, ctx), date, "", isHard(type));
    // the time trial is on Thursday; the planner put hard sessions on Tuesday and Friday
    const fresh = [w("2026-11-17", "threshold"), w("2026-11-20", "vo2max"), w("2026-11-22", "long")];
    const out = easeAroundTimeTrials(fresh, ["2026-11-19"], ctx);
    expect(out.map((x) => x.type)).toEqual(["threshold", "recovery", "long"]);
    // when the planner had its own hard session on the time trial's day, that one was already replaced
    const out2 = easeAroundTimeTrials([w("2026-11-17", "threshold"), w("2026-11-22", "long")], ["2026-11-19"], ctx, [w("2026-11-19", "tempo")]);
    expect(out2.map((x) => x.type)).toEqual(["threshold", "long"]);
  });
});
