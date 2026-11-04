/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { deletePlan, updateGoal } = await import("../src/lib/planning/service");

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
      if (op.kind === "insert") rows().push({ id: `id${++seq}`, ...op.payload });
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
