/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { deletePlan, updateGoal } = await import("../src/lib/planning/service");
const { generatePlan } = await import("../src/lib/planning/generator");
const { addDaysIso } = await import("../src/lib/dates");

type Row = Record<string, any>;
/** In-memory Supabase with just enough for the goal edit: filters, update, insert, delete, and the plan → goal join (with cascade). */
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: string; payload?: any } = { kind: "select" };
    let join = false;
    let single = false;
    const rows = () => (tables[table] ??= []);
    const q: any = {
      select: (s?: string) => ((join = !!s?.includes("goal:goals")), q),
      eq: (k: string, v: any) => (filters.push((r) => r[k] === v), q),
      in: (k: string, vs: any[]) => (filters.push((r) => vs.includes(r[k])), q),
      is: (k: string, v: any) => (filters.push((r) => (r[k] ?? null) === v), q),
      gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), q),
      lte: (k: string, v: any) => (filters.push((r) => r[k] <= v), q),
      lt: (k: string, v: any) => (filters.push((r) => r[k] < v), q),
      limit: () => q,
      order: () => q,
      maybeSingle: () => ((single = true), q),
      single: () => ((single = true), q),
      update: (p: any) => ((op = { kind: "update", payload: p }), q),
      insert: (p: any) => ((op = { kind: "insert", payload: p }), q),
      delete: () => ((op = { kind: "delete" }), q),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    const run = () => {
      const match = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") match.forEach((r) => Object.assign(r, op.payload));
      if (op.kind === "insert") for (const p of [op.payload].flat()) rows().push({ id: `id${++seq}`, ...p });
      if (op.kind === "delete") {
        tables[table] = rows().filter((r) => !match.includes(r));
        // goals → training_plans → planned_workouts / plan_versions cascade
        if (table === "goals") {
          const ids = match.map((g) => g.id);
          const plans = (tables.training_plans ?? []).filter((p) => ids.includes(p.goal_id)).map((p) => p.id);
          tables.training_plans = (tables.training_plans ?? []).filter((p) => !plans.includes(p.id));
          for (const t of ["planned_workouts", "plan_versions"]) tables[t] = (tables[t] ?? []).filter((r) => !plans.includes(r.plan_id));
        }
      }
      const out = join ? match.map((r) => ({ ...r, goal: tables.goals.find((g) => g.id === r.goal_id) })) : match;
      return { data: single ? (out[0] ?? null) : out, error: null };
    };
    return q;
  };
  return { from } as any;
}

function setup() {
  const workout = { id: "w1", plan_id: "p", user_id: "u", date: "2026-11-10", type: "race_pace", title: "Race pace", steps: [{ kind: "run" }], status: "planned" };
  const tables: Record<string, Row[]> = {
    goals: [{ id: "g", user_id: "u", kind: "half", name: null, distance_m: null, race_date: "2027-03-01", target_time_s: 6600, target_weekly_km: null }],
    training_plans: [
      {
        id: "p",
        user_id: "u",
        goal_id: "g",
        status: "active",
        race_pace: 313,
        current_version: 1,
        config: { startDate: "2026-11-02", weeks: 17, runDays: [0, 2, 4, 6], longRunDay: 6, unavailableDays: [1, 3, 5], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: true, refreshedWeek: "2026-11-02" },
      },
    ],
    planned_workouts: [workout],
    plan_versions: [],
  };
  return { tables, db: fakeDb(tables), workout: { ...workout } };
}

describe("updateGoal", () => {
  it("changes the target time without touching workouts or the plan's race pace", async () => {
    const { tables, db, workout } = setup();
    const changes = await updateGoal(db, "u", { targetTimeS: 6300 });
    expect(changes).toEqual(["target 1:45:00"]);
    expect(tables.goals[0].target_time_s).toBe(6300);
    expect(tables.goals[0].race_date).toBe("2027-03-01");
    expect(tables.planned_workouts).toEqual([workout]);
    expect(tables.training_plans[0].race_pace).toBe(313);
    // recorded in History
    expect(tables.plan_versions).toHaveLength(1);
    expect(tables.plan_versions[0].reason).toContain("Workouts unchanged");
    expect(tables.training_plans[0].current_version).toBe(2);
  });

  it("merges settings into the plan config and keeps the rest", async () => {
    const { tables, db } = setup();
    await updateGoal(db, "u", { config: { runDays: [1, 3, 5], unavailableDays: [0, 2, 4, 6], maxWeeklyMinutes: 300 } });
    const cfg = tables.training_plans[0].config;
    expect(cfg.runDays).toEqual([1, 3, 5]);
    expect(cfg.maxWeeklyMinutes).toBe(300);
    expect(cfg.startDate).toBe("2026-11-02");
    expect(cfg.refreshedWeek).toBe("2026-11-02");
    expect(tables.planned_workouts).toHaveLength(1);
  });

  it("does nothing when nothing changed", async () => {
    const { tables, db } = setup();
    const changes = await updateGoal(db, "u", { targetTimeS: 6600, config: { runDays: [0, 2, 4, 6], includeStrides: true } });
    expect(changes).toEqual([]);
    expect(tables.plan_versions).toHaveLength(0);
  });

  it("refuses without an active plan", async () => {
    const { tables, db } = setup();
    tables.training_plans[0].status = "archived";
    await expect(updateGoal(db, "u", { targetTimeS: 6000 })).rejects.toThrow("No active plan");
  });
});

describe("deletePlan", () => {
  it("removes the active plan, its goal and workouts", async () => {
    const { tables, db } = setup();
    expect(await deletePlan(db, "u")).toBe(true);
    expect(tables.goals).toHaveLength(0);
    expect(tables.training_plans).toHaveLength(0);
    expect(tables.planned_workouts).toHaveLength(0);
  });

  it("only deletes the caller's plan", async () => {
    const { tables, db } = setup();
    expect(await deletePlan(db, "someone-else")).toBe(false);
    expect(tables.goals).toHaveLength(1);
  });
});

describe("changing runs per week", () => {
  it("rebalances the weeks to come, keeping finished workouts", async () => {
    const goal = { kind: "10k" as const, name: null, distanceM: null, raceDate: null, targetTimeS: null, targetWeeklyKm: null };
    const today = "2026-11-04";
    const baseline: any = {
      asOf: today, vdot: null, vdotRange: null, vdotConfidence: null, paceZones: null, hrZones: null, thresholdHr: null,
      weeklyMinutes: 120, weeklyKm: 20, runsPerWeek: 2, consistency: 1, longestRunMinutes: 50, longestRun30Minutes: 50,
      recentWeeks: [120, 120, 120, 120], recentRunCounts: [2, 2, 2, 2], habitualRunMinutes: 50, predictions: [],
    };
    const config: any = { startDate: "2026-11-02", weeks: 8, runDays: [0, 1, 2, 3, 4, 5, 6], runsPerWeek: 2, longRunDay: 6, unavailableDays: [], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: true };
    const gen = generatePlan(goal, config, baseline);
    const tables: Record<string, Row[]> = {
      goals: [{ id: "g", user_id: "u", kind: "10k", name: null, distance_m: null, race_date: null, target_time_s: null, target_weekly_km: null }],
      training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", race_pace: null, current_version: 1, config: gen.config, baseline, weeks: gen.weeks }],
      planned_workouts: gen.workouts.map((w, i) => ({ id: `w${i}`, plan_id: "p", user_id: "u", date: w.date, type: w.type, steps: w.steps, status: w.date < today ? "done" : "planned", locked: false, source: "generator" })),
      plan_versions: [],
      activities: [],
      adaptation_proposals: [],
    };
    const db = fakeDb(tables);
    const runsIn = (from: string, to: string) => tables.planned_workouts.filter((w) => w.type !== "rest" && w.date >= from && w.date <= to).length;
    const nextWeek = addDaysIso(gen.weeks[1].start, 0);
    expect(runsIn(nextWeek, addDaysIso(nextWeek, 6))).toBe(2);
    const done = tables.planned_workouts.filter((w) => w.status === "done").map((w) => w.id);

    await updateGoal(db, "u", { config: { runsPerWeek: 3 } }, { today });

    expect(tables.training_plans[0].config.runsPerWeek).toBe(3);
    expect(runsIn(nextWeek, addDaysIso(nextWeek, 6))).toBe(3);
    for (const id of done) expect(tables.planned_workouts.some((w) => w.id === id)).toBe(true);
    expect(tables.plan_versions.at(-1)!.reason).toContain("3 runs a week");
  });

  it("does not add a second time trial when settings change after the first one", async () => {
    const goal = { kind: "10k" as const, name: null, distanceM: null, raceDate: null, targetTimeS: null, targetWeeklyKm: null };
    const baseline: any = {
      asOf: "2026-11-02", vdot: null, vdotRange: null, vdotConfidence: null, paceZones: null, hrZones: null, thresholdHr: null,
      weeklyMinutes: 150, weeklyKm: 25, runsPerWeek: 4, consistency: 1, longestRunMinutes: 60, longestRun30Minutes: 60,
      recentWeeks: [150, 150, 150, 150], recentRunCounts: [4, 4, 4, 4], habitualRunMinutes: 40, predictions: [],
    };
    const config: any = { startDate: "2026-11-02", weeks: 8, runDays: [0, 1, 2, 3, 4, 6], runsPerWeek: 4, longRunDay: 6, unavailableDays: [], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: true, baselineTimeTrial: true };
    const gen = generatePlan(goal, config, baseline);
    const tt = gen.workouts.find((w) => w.type === "time_trial");
    expect(tt).toBeTruthy();
    const today = addDaysIso(tt!.date, 1);
    const tables: Record<string, Row[]> = {
      goals: [{ id: "g", user_id: "u", kind: "10k", name: null, distance_m: null, race_date: null, target_time_s: null, target_weekly_km: null }],
      training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", race_pace: null, current_version: 1, config: gen.config, baseline, weeks: gen.weeks }],
      planned_workouts: gen.workouts.map((w, i) => ({ id: `w${i}`, plan_id: "p", user_id: "u", date: w.date, type: w.type, steps: w.steps, status: w.date < today ? "done" : "planned", locked: false, source: "generator" })),
      plan_versions: [],
      activities: Array.from({ length: 32 }, (_, k) => ({ id: `a${k}`, user_id: "u", sport: "running", duplicate_of: null, local_date: addDaysIso("2026-11-01", -Math.floor(k * 1.75)), moving_s: k % 4 === 0 ? 3600 : 2400, distance_m: k % 4 === 0 ? 11000 : 7000, elevation_gain_m: 40 })),
      adaptation_proposals: [],
    };
    const db = fakeDb(tables);

    await updateGoal(db, "u", { config: { includeStrides: false } }, { today });

    expect(tables.planned_workouts.filter((w) => w.type === "time_trial")).toHaveLength(1);
    // the rest of week 1 is rebuilt with real runs, not left empty where a second time trial was dropped
    const rest = tables.planned_workouts.filter((w) => w.date >= today && w.date <= "2026-11-08" && w.type !== "rest");
    expect(rest.length).toBeGreaterThanOrEqual(2);
  });

  it("does not bring back a time trial that was swapped for another run", async () => {
    const goal = { kind: "10k" as const, name: null, distanceM: null, raceDate: null, targetTimeS: null, targetWeeklyKm: null };
    const baseline: any = {
      asOf: "2026-11-02", vdot: null, vdotRange: null, vdotConfidence: null, paceZones: null, hrZones: null, thresholdHr: null,
      weeklyMinutes: 150, weeklyKm: 25, runsPerWeek: 4, consistency: 1, longestRunMinutes: 60, longestRun30Minutes: 60,
      recentWeeks: [150, 150, 150, 150], recentRunCounts: [4, 4, 4, 4], habitualRunMinutes: 40, predictions: [],
    };
    const config: any = { startDate: "2026-11-02", weeks: 8, runDays: [0, 1, 2, 3, 4, 6], runsPerWeek: 4, longRunDay: 6, unavailableDays: [], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: true, baselineTimeTrial: true };
    const gen = generatePlan(goal, config, baseline);
    const today = "2026-11-02";
    const tables: Record<string, Row[]> = {
      goals: [{ id: "g", user_id: "u", kind: "10k", name: null, distance_m: null, race_date: null, target_time_s: null, target_weekly_km: null }],
      training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", race_pace: null, current_version: 1, config: gen.config, baseline, weeks: gen.weeks }],
      // the athlete swapped the time trial for an easy run
      planned_workouts: gen.workouts.map((w, i) => ({ id: `w${i}`, plan_id: "p", user_id: "u", date: w.date, type: w.type === "time_trial" ? "easy" : w.type, steps: w.steps, status: "planned", locked: false, source: w.type === "time_trial" ? "athlete" : "generator" })),
      plan_versions: [],
      activities: Array.from({ length: 32 }, (_, k) => ({ id: `a${k}`, user_id: "u", sport: "running", duplicate_of: null, local_date: addDaysIso("2026-11-01", -Math.floor(k * 1.75)), moving_s: k % 4 === 0 ? 3600 : 2400, distance_m: k % 4 === 0 ? 11000 : 7000, elevation_gain_m: 40 })),
      adaptation_proposals: [],
    };
    const db = fakeDb(tables);

    await updateGoal(db, "u", { config: { runDays: [0, 1, 3, 5, 6] } }, { today });

    expect(tables.planned_workouts.filter((w) => w.type === "time_trial")).toHaveLength(0);
  });

  it("leaves workouts alone when only the target time changes", async () => {
    const { tables, db, workout } = setup();
    await updateGoal(db, "u", { targetTimeS: 6000 }, { today: "2026-11-04" });
    expect(tables.planned_workouts).toEqual([workout]);
  });
});
