import { describe, expect, it } from "vitest";
import { addDaysIso } from "@/lib/dates";
import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { CLIMB_M_PER_KM, RUNNING_LOAD_VERSION, intensityFactor, loadRatio, loadTemper, runLoad, weeklyLoadRatio } from "@/lib/analytics/running-load";
import { VERSIONS } from "@/lib/analytics/versions";
import { weeklyVolume } from "@/lib/analytics/volume";
import { buildBaseline, type BaselineRun } from "@/lib/planning/baseline";
import { generatePlan } from "@/lib/planning/generator";
import { proposeAdaptations, type AdaptWorkout } from "@/lib/planning/adapt";
import { isHard, type Goal, type PlanConfig } from "@/lib/planning/types";

describe("runLoad", () => {
  it("is plain distance for a flat easy run", () => {
    expect(runLoad({ distanceM: 10_000 })).toBe(10);
    expect(runLoad({ distanceM: 10_000, elevationGainM: 0, zoneSeconds: [0, 600, 2400, 0, 0, 0] })).toBe(10);
    expect(runLoad({ distanceM: null })).toBe(0);
  });

  it("counts 100 m of climbing as 1 km", () => {
    expect(CLIMB_M_PER_KM).toBe(100);
    expect(runLoad({ distanceM: 8000, elevationGainM: 400 })).toBeCloseTo(12);
    expect(runLoad({ distanceM: 8000, elevationGainM: -50 })).toBeCloseTo(8);
  });

  it("weights time at high heart rate", () => {
    // all in zone 4 → 1.5, all in zone 5 → 2, half easy half zone 5 → 1.5
    expect(intensityFactor([0, 0, 0, 0, 1800, 0])).toBeCloseTo(1.5);
    expect(intensityFactor([0, 0, 0, 0, 0, 1800])).toBeCloseTo(2);
    expect(intensityFactor([0, 0, 900, 0, 0, 900])).toBeCloseTo(1.5);
    expect(runLoad({ distanceM: 10_000, elevationGainM: 100, zoneSeconds: [0, 0, 0, 0, 3000, 0] })).toBeCloseTo(16.5);
  });

  it("falls back to the run's intensity, else 1", () => {
    expect(intensityFactor(null, 0.65)).toBe(1);
    expect(intensityFactor(null, 0.9)).toBeCloseTo(1.5);
    expect(intensityFactor(null, 1)).toBeCloseTo(2);
    expect(intensityFactor([0, 0, 0, 0, 0, 0], 0.9)).toBeCloseTo(1.5);
    expect(intensityFactor(undefined, null)).toBe(1);
  });

  it("is versioned", () => {
    expect(RUNNING_LOAD_VERSION).toBe(VERSIONS.runningLoad);
  });
});

describe("loadRatio and loadTemper", () => {
  const asOf = "2026-11-08";
  const weekly = (loads: number[]) => loads.map((l, k) => ({ date: addDaysIso(asOf, -7 * (3 - k) - 2), load: l }));

  it("compares the last 7 days with the 4-week average", () => {
    const r = loadRatio(weekly([20, 20, 20, 40]), asOf)!;
    expect(r.acute).toBe(40);
    expect(r.chronic).toBe(25);
    expect(r.ratio).toBe(1.6);
  });

  it("works on calendar-week totals too", () => {
    expect(weeklyLoadRatio([20, 20, 20, 40])!.ratio).toBe(1.6);
    expect(weeklyLoadRatio([0, 0, 20, 40])).toBeNull();
  });

  it("needs runs in at least 3 of the 4 weeks", () => {
    expect(loadRatio(weekly([0, 0, 20, 40]), asOf)).toBeNull();
    expect(loadRatio([], asOf)).toBeNull();
  });

  it("only ever holds the next week back", () => {
    expect(loadTemper(null)).toBe(1);
    expect(loadTemper(0.6)).toBe(1);
    expect(loadTemper(1.3)).toBe(1);
    expect(loadTemper(1.45)).toBeCloseTo(0.5);
    expect(loadTemper(1.6)).toBe(0);
    expect(loadTemper(3)).toBe(0);
  });
});

describe("weeklyVolume load", () => {
  it("adds the load beside km", () => {
    const w = weeklyVolume(
      [
        { id: "a", local_date: "2026-11-02", distance_m: 10_000, moving_s: 3000, elevation_gain_m: 300, sport: "running" },
        { id: "b", local_date: "2026-11-04", distance_m: 5000, moving_s: 1500, elevation_gain_m: 0, sport: "running" },
      ],
      "2026-11-02",
      "2026-11-08",
      new Map([["b", { zoneSeconds: [0, 0, 0, 0, 1500, 0], intensity: null }]]),
    );
    expect(w[0].distanceM).toBe(15_000);
    expect(w[0].loadKm).toBeCloseTo(13 + 7.5);
  });
});

// --- the planner ------------------------------------------------------------------
const asOf = "2026-11-09"; // Monday
const fitness = {
  estimate: { withheld: false, vdot: 45, lower: 44, upper: 46, confidence: "medium" as const },
  paceZones: trainingPaces(45),
  hrZones: null,
  threshold: { hr: 172 },
  predictions: [5000, 10_000, 21_097.5].map((d) => ({ distanceM: d, timeS: predictTimeS(45, d) })),
};
/** 8 weeks of 3 flat easy 8 km runs; the last week's runs get `last` added */
function history(last: Partial<BaselineRun> = {}): BaselineRun[] {
  const runs: BaselineRun[] = [];
  for (let w = 8; w >= 1; w--) {
    for (const d of [0, 2, 5]) {
      const date = addDaysIso(asOf, -7 * w + d);
      runs.push({ date, movingS: 8 * 330, distanceM: 8000, elevationGainM: 20, zoneSeconds: null, intensity: 0.65, ...(w === 1 ? last : {}) });
    }
  }
  return runs;
}
const tenK: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-03-20", targetTimeS: null, targetWeeklyKm: null };
const config: PlanConfig = {
  startDate: asOf,
  weeks: 12,
  runDays: [0, 2, 4, 6],
  longRunDay: 6,
  unavailableDays: [],
  maxWeeklyMinutes: null,
  includeIntervals: true,
  includeLongRuns: true,
  includeStrides: true,
};

describe("planner uses running load", () => {
  const flat = buildBaseline(asOf, fitness, history());
  const hilly = buildBaseline(asOf, fitness, history({ elevationGainM: 600, intensity: 0.9 }));

  it("the baseline carries weekly load, and a hilly hard week counts as a big week at the same km", () => {
    expect(hilly.weeklyKm).toBe(flat.weeklyKm);
    expect(flat.recentLoad).toHaveLength(4);
    expect(hilly.recentLoad!.at(-1)!).toBeGreaterThan(2 * flat.recentLoad!.at(-1)!);
    expect(flat.loadTemper).toBe(1);
    expect(hilly.loadRatio!).toBeGreaterThan(1.3);
    expect(hilly.loadTemper!).toBeLessThan(1);
  });

  it("holds the next week's growth back after a high-load week", () => {
    const pFlat = generatePlan(tenK, config, flat);
    const pHilly = generatePlan(tenK, config, hilly);
    expect(pHilly.weeks[0].targetMinutes).toBeLessThan(pFlat.weeks[0].targetMinutes);
    // never below your usual week
    expect(pHilly.weeks[0].targetMinutes).toBeGreaterThanOrEqual(flat.weeklyMinutes * 0.9);
  });

  it("is dynamic: without zones or elevation, load is distance and nothing changes", () => {
    const bare = buildBaseline(asOf, fitness, history().map((r) => ({ date: r.date, movingS: r.movingS, distanceM: r.distanceM })));
    expect(bare.loadTemper).toBe(1);
    expect(generatePlan(tenK, config, bare).weeks[0].targetMinutes).toBe(generatePlan(tenK, config, flat).weeks[0].targetMinutes);
  });
});

describe("adaptation: running-load spike (C)", () => {
  const baseline = buildBaseline(asOf, fitness, history());
  const plan = generatePlan(tenK, config, baseline);
  const today = addDaysIso(asOf, 14);
  const ws: AdaptWorkout[] = plan.workouts.map((w, i) => ({ ...w, id: `w${i}`, locked: false, status: w.date < today ? "completed" : "planned", execution: null, rpe: null }));
  const done = ws.filter((w) => w.date < today);
  const runs = (spike: boolean) =>
    [...history().filter((r) => r.date >= addDaysIso(today, -35)), ...done.map((w) => ({ date: w.date, movingS: w.durationS, distanceM: w.distanceM }))].map((r) => ({
      date: r.date,
      movingS: r.movingS,
      classification: "easy",
      rpe: null,
      legs: null,
      load: (r.distanceM ?? 0) / 1000 * (spike && r.date >= addDaysIso(today, -6) ? 2.5 : 1),
    }));
  const input = { today, goal: tenK, baseline: plan.baseline, racePace: plan.racePace, raceLabel: "10 km", workouts: ws, fitness: null, existingKeys: new Set<string>() };

  it("eases the next hard session when the last 7 days' load jumps", () => {
    expect(proposeAdaptations({ ...input, runs: runs(false) }).find((p) => p.rule === "C")).toBeUndefined();
    const nextHard = ws.find((w) => w.date >= today && w.date <= addDaysIso(today, 3) && isHard(w.type));
    const c = proposeAdaptations({ ...input, runs: runs(true) }).find((p) => p.rule === "C");
    expect(nextHard).toBeTruthy();
    expect(c).toBeTruthy();
    expect(c!.explanation).toMatch(/running load/);
    expect(c!.evidence.join(" ")).toMatch(/equivalent km/);
    expect(c!.changes[0].after.type).toBe("easy");
  });
});
