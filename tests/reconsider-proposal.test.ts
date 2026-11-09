/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { addDaysIso } from "@/lib/dates";
import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { buildBaseline, type BaselineFitness, type BaselineRun } from "@/lib/planning/baseline";
import { generatePlan } from "@/lib/planning/generator";
import { proposeAdaptations } from "@/lib/planning/adapt";
import type { Goal, PlanConfig } from "@/lib/planning/types";

vi.mock("server-only", () => ({}));
const { decideProposal, undoProposal, planContext, activePlan } = await import("@/lib/planning/service");

const START = "2026-11-02";
const TODAY = "2026-11-10";
const fitness = (vdot: number): BaselineFitness => ({
  estimate: { withheld: false, vdot, lower: vdot - 2, upper: vdot + 2, confidence: "high" },
  paceZones: trainingPaces(vdot),
  hrZones: null,
  threshold: null,
  predictions: [5000, 10000].map((d) => ({ distanceM: d, timeS: predictTimeS(vdot, d) })),
});
const runs: BaselineRun[] = [];
for (let w = 1; w <= 8; w++) for (const d of [1, 3, 6]) runs.push({ date: addDaysIso(START, -7 * w + d), distanceM: 7000, movingS: 7 * 360 });
const goal: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-02-14", targetTimeS: null, targetWeeklyKm: null };
const config: PlanConfig = { startDate: START, weeks: 15, runDays: [1, 3, 5], runsPerWeek: 3, longRunDay: 5, unavailableDays: [], maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: false, baselineTimeTrial: false };

function setup() {
  const baseline = buildBaseline(addDaysIso(START, -1), fitness(41.5), runs);
  const gen = generatePlan(goal, config, baseline);
  const db = new FakeDb({
    goals: [{ id: "g", user_id: "u", kind: goal.kind, name: null, distance_m: null, race_date: goal.raceDate, target_time_s: null, target_weekly_km: null }],
    training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", race_pace: gen.racePace, current_version: 1, config: gen.config, baseline: gen.baseline, weeks: gen.weeks, summary: gen.summary, warnings: [] }],
    planned_workouts: gen.workouts.map((w, i) => ({
      id: `w${i}`, plan_id: "p", user_id: "u", date: w.date, type: w.type, title: w.title, objective: w.objective, why: w.why, steps: w.steps,
      duration_s: Math.round(w.durationS), distance_m: w.distanceM, key: w.key, locked: false, source: "generator", status: w.date < TODAY ? "completed" : "planned",
    })),
    plan_versions: [],
    adaptation_proposals: [],
  });
  return db;
}

async function propose(db: FakeDb) {
  const plan = await activePlan(db as any, "u");
  const ctx = planContext(plan);
  const ws = (db as any).tables.planned_workouts.map((w: any) => ({ ...w, durationS: w.duration_s, distanceM: w.distance_m }));
  const [p] = proposeAdaptations({ today: TODAY, goal, baseline: ctx.baseline, racePace: ctx.racePace, raceLabel: ctx.raceLabel, workouts: ws, runs: [], fitness: { vdot: 43.4, confidence: "high" }, existingKeys: new Set() });
  expect(p.rule).toBe("A");
  (db as any).tables.adaptation_proposals.push({ id: "a", plan_id: "p", user_id: "u", rule: p.rule, key: p.key, title: p.title, explanation: p.explanation, evidence: p.evidence, changes: p.changes, baseline_patch: p.baselinePatch, status: "pending" });
  return p;
}

const easy = trainingPaces(43.4).find((z) => z.key === "easy")!;
const usesNewPaces = (w: any) => JSON.stringify(w.steps).includes(`"paceFast":${Math.round(easy.fastSPerKm)},`);

describe("a declined pace update", () => {
  it("can be applied later, retargeting the plan as it is now, and undone", async () => {
    const db = setup();
    await propose(db);
    await decideProposal(db as any, "u", "a", false, undefined, TODAY);
    expect((db as any).tables.adaptation_proposals[0].status).toBe("rejected");

    // the weekly refresh rewrites a coming workout after the proposal was made
    const t = (db as any).tables;
    const later = t.planned_workouts.find((w: any) => w.date > TODAY && ["threshold", "intervals", "tempo"].includes(w.type) && w.status === "planned");
    later.title = `${later.title} (refreshed)`;

    const r = await decideProposal(db as any, "u", "a", true, undefined, TODAY);
    const p = t.adaptation_proposals[0];
    expect(p.status).toBe("accepted");
    expect(r?.applied).toBeGreaterThan(5);
    expect(t.training_plans[0].baseline.vdot).toBe(43.4);
    expect(usesNewPaces(t.planned_workouts.find((w: any) => w.id === later.id))).toBe(true);
    // finished runs keep their targets
    expect(t.planned_workouts.filter((w: any) => w.status === "completed").some(usesNewPaces)).toBe(false);

    await undoProposal(db as any, "u", "a");
    expect(t.training_plans[0].baseline.vdot).toBe(41.5);
    expect(usesNewPaces(t.planned_workouts.find((w: any) => w.id === later.id))).toBe(false);
  });

  it("can't be reopened after two weeks", async () => {
    const db = setup();
    await propose(db);
    await decideProposal(db as any, "u", "a", false, undefined, TODAY);
    (db as any).tables.adaptation_proposals[0].decided_at = "2026-10-01T00:00:00Z";
    await decideProposal(db as any, "u", "a", true, undefined, TODAY);
    expect((db as any).tables.adaptation_proposals[0].status).toBe("rejected");
  });
});
