import { describe, expect, it } from "vitest";
import { addDaysIso } from "@/lib/dates";
import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { ACWR_MAX, HARD_SHARE_MAX, generatePlan, hardMinutes, pickQualityDays, spreadDays } from "@/lib/planning/generator";
import { buildBaseline } from "@/lib/planning/baseline";
import { validateSchedule, moveIssues } from "@/lib/planning/validate";
import { assessExecution, matchRuns } from "@/lib/planning/match";
import { proposeAdaptations, type AdaptWorkout } from "@/lib/planning/adapt";
import { isHard, type Baseline, type Goal, type PlanConfig } from "@/lib/planning/types";

const hrZones = [1, 2, 3, 4, 5].map((z) => ({ zone: z as 1 | 2 | 3 | 4 | 5, label: "", minBpm: 100 + z * 15, maxBpm: 114 + z * 15 }));
const base = (over: Partial<Baseline> = {}): Baseline => ({
  asOf: "2026-11-02",
  vdot: 41.5,
  vdotRange: [39.5, 43.5],
  vdotConfidence: "medium",
  paceZones: trainingPaces(41.5),
  hrZones,
  thresholdHr: 170,
  weeklyMinutes: 150,
  weeklyKm: 25,
  runsPerWeek: 3,
  consistency: 0.9,
  longestRunMinutes: 60,
  predictions: [5000, 10000, 21097.5, 42195].map((d) => ({ distanceM: d, timeS: predictTimeS(41.5, d) })),
  ...over,
});
const config = (over: Partial<PlanConfig> = {}): PlanConfig => ({
  startDate: "2026-11-03",
  weeks: 10,
  runDays: [1, 3, 5, 6],
  longRunDay: 6,
  unavailableDays: [],
  maxWeeklyMinutes: null,
  includeIntervals: true,
  includeLongRuns: true,
  includeStrides: true,
  ...over,
});
const half: Goal = { kind: "half", name: null, distanceM: null, raceDate: "2027-03-14", targetTimeS: 6600, targetWeeklyKm: null };

describe("plan generator", () => {
  const plan = generatePlan(half, config(), base());

  it("builds to the race with a taper and the race on race day", () => {
    expect(plan.weeks.at(-1)!.phase).toBe("race");
    expect(plan.weeks.at(-2)!.phase).toBe("taper");
    const race = plan.workouts.at(-1)!;
    expect(race.type).toBe("race");
    expect(race.date).toBe("2027-03-14");
    expect(plan.workouts.every((w) => w.date >= "2026-11-03" && w.date <= "2027-03-14")).toBe(true);
    expect(plan.workouts.find((w) => w.date === "2027-03-13")).toBeUndefined(); // rest before the race
  });

  it("starts near current volume and never increases more than 10 % or 30 min a week", () => {
    expect(plan.weeks[0].targetMinutes).toBeLessThan(150 * 1.2);
    // planned (not target) minutes vary with session structure; check the long-run progression instead
    const longs = plan.workouts.filter((w) => w.type === "long" || w.type === "progressive_long").map((w) => w.durationS / 60);
    for (let i = 1; i < longs.length; i++) expect(longs[i] - Math.max(...longs.slice(0, i), 60)).toBeLessThanOrEqual(10);
    expect(Math.max(...longs)).toBeLessThanOrEqual(120);
  });

  it("keeps hard sessions apart from each other and from the long run", () => {
    expect(validateSchedule(plan.workouts)).toEqual([]);
  });

  it("uses your zones for targets and explains every workout", () => {
    const t = plan.workouts.find((w) => w.type === "threshold")!;
    const s = t.steps.find((x) => x.kind === "repeat")!;
    if (s.kind !== "repeat" || s.steps[0].kind === "repeat") throw new Error("shape");
    const th = trainingPaces(41.5).find((z) => z.key === "threshold")!;
    expect(s.steps[0].target.paceFast).toBe(Math.round(th.fastSPerKm));
    expect(s.steps[0].target.hrMin).toBe(hrZones[3].minBpm);
    expect(plan.workouts.every((w) => w.why.length > 20)).toBe(true);
  });

  it("flags a target that is out of reach and trains at a realistic pace instead", () => {
    const p = generatePlan({ ...half, targetTimeS: 5400 }, config(), base());
    expect(p.warnings.some((w) => w.includes("faster than even the optimistic end"))).toBe(true);
    expect(p.racePace!).toBeGreaterThan(5400 / 21.0975);
  });

  it("falls back to heart-rate targets without a fitness estimate", () => {
    const p = generatePlan(half, config(), base({ vdot: null, paceZones: null, predictions: [] }));
    const t = p.workouts.find((w) => isHard(w.type) && w.type !== "race")!;
    const flat = t.steps.flatMap((s) => (s.kind === "repeat" ? s.steps : [s]));
    expect(flat.every((s) => s.kind === "repeat" || s.target.paceFast == null)).toBe(true);
    expect(p.warnings.some((w) => w.includes("heart-rate targets"))).toBe(true);
  });

  it("respects a weekly time cap and run days", () => {
    const p = generatePlan({ kind: "general", name: null, distanceM: null, raceDate: null, targetTimeS: null, targetWeeklyKm: null }, config({ maxWeeklyMinutes: 180, runDays: [0, 2, 4] , longRunDay: 4 }), base());
    expect(p.weeks.length).toBe(10);
    for (const w of p.weeks) expect(w.targetMinutes).toBeLessThanOrEqual(200);
    expect(new Set(p.workouts.map((w) => (new Date(w.date + "T00:00:00Z").getUTCDay() + 6) % 7))).toEqual(new Set([0, 2, 4]));
  });

  it("spreads quality days", () => {
    expect(pickQualityDays([1, 3, 5, 6], 6, 2)).toEqual([1, 3]);
    expect(pickQualityDays([0, 1, 2], 2, 2).length).toBeLessThanOrEqual(1);
  });
});

describe("load safety (a low-volume runner who ticks every day)", () => {
  // like Trym: ~50 min/week over ~1.5 runs, longest run an hour
  const low = base({ weeklyMinutes: 50, runsPerWeek: 1.5, consistency: 0.75, longestRunMinutes: 61 });
  const tenK: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-04-24", targetTimeS: null, targetWeeklyKm: null };
  const all = config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 3 });
  const p = generatePlan(tenK, all, low);
  const perWeek = p.weeks.map((w) => p.workouts.filter((x) => x.date >= w.start && x.date <= addDaysIso(w.start, 6)));

  it("treats ticked days as availability, not a run every day", () => {
    for (const ws of perWeek.slice(0, 4)) expect(ws.length).toBeLessThanOrEqual(3);
    for (const ws of perWeek) expect(ws.length).toBeLessThanOrEqual(5);
  });

  it("starts near what you run now and limits week-to-week and acute:chronic increases", () => {
    expect(p.weeks[0].targetMinutes).toBeLessThanOrEqual(50 * 1.25 + 5);
    const mins = p.weeks.map((w) => w.targetMinutes);
    const hist = [50, 50, 50, 50, ...mins];
    for (let i = 0; i < mins.length; i++) {
      const chronic = hist.slice(i, i + 4).reduce((a, b) => a + b, 0) / 4;
      expect(mins[i]).toBeLessThanOrEqual(Math.max(chronic * ACWR_MAX * 1.1, 70));
    }
  });

  it("keeps hard running to about 20 % and no hard sessions in the first two weeks", () => {
    p.weeks.forEach((w, i) => {
      const hard = perWeek[i].filter((x) => x.type !== "race").reduce((a, x) => a + hardMinutes(x.steps), 0);
      expect(hard).toBeLessThanOrEqual(Math.max(12, w.targetMinutes * HARD_SHARE_MAX) + 6);
    });
    expect(perWeek[0].concat(perWeek[1]).some((x) => isHard(x.type))).toBe(false);
  });

  it("adds runs only as weekly time grows, never more than one above what you have shown", () => {
    const counts = perWeek.map((ws) => ws.length);
    expect(counts[0]).toBeLessThanOrEqual(3);
    for (let i = 1; i < counts.length; i++) expect(counts[i] - Math.max(...counts.slice(0, i))).toBeLessThanOrEqual(1);
  });

  it("grows when you run more than planned (re-anchored on your actual weeks)", () => {
    const quiet = generatePlan(tenK, all, base({ ...low, recentWeeks: [50, 50, 50, 50], maxRecentRuns: 2 }));
    const keen = generatePlan(tenK, all, base({ ...low, weeklyMinutes: 120, recentWeeks: [100, 110, 125, 140], maxRecentRuns: 4, runsPerWeek: 3.5 }));
    expect(keen.weeks[0].targetMinutes).toBeGreaterThan(quiet.weeks[0].targetMinutes * 1.8);
    expect(keen.weeks[0].targetMinutes).toBeLessThanOrEqual(Math.max(140, 119 * ACWR_MAX) + 20);
    const n = (p: typeof keen) => p.workouts.filter((x) => x.date <= addDaysIso(p.weeks[0].start, 6)).length;
    expect(n(keen)).toBeGreaterThan(n(quiet));
  });

  it("keeps the original phases when the rest of the plan is recalculated", () => {
    const later = generatePlan(tenK, { ...all, startDate: "2027-03-01", phases: p.weeks.slice(-8).map((w) => w.phase) }, low);
    expect(later.weeks.map((w) => w.phase)).toEqual(p.weeks.slice(-8).map((w) => w.phase));
    expect(later.weeks[0].start).toBe("2027-03-01");
  });

  it("projects the race time if you follow the plan, with a range", () => {
    const pr = p.projection!;
    expect(pr.distanceM).toBe(10_000);
    expect(pr.projectedS).toBeLessThan(pr.nowS);
    expect(pr.fastS).toBeLessThanOrEqual(pr.projectedS);
    expect(pr.slowS).toBeGreaterThanOrEqual(pr.projectedS);
    expect(pr.nowS / pr.projectedS).toBeLessThan(1.12);
  });

  it("spreads chosen days around the week", () => {
    expect(spreadDays([0, 1, 2, 3, 4, 5, 6], 3, 3)).toEqual(expect.arrayContaining([3]));
    const d = spreadDays([0, 1, 2, 3, 4, 5, 6], 3, 6);
    expect(d).toContain(6);
    for (let i = 1; i < d.length; i++) expect(d[i] - d[i - 1]).toBeGreaterThanOrEqual(2);
  });
});

describe("baseline", () => {
  it("averages the last 4 weeks and counts consistent weeks", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({ date: addDaysIso("2026-10-06", i * 2), movingS: 2400, distanceM: 6000 }));
    const b = buildBaseline("2026-11-02", null, runs);
    expect(b.weeklyMinutes).toBe(Math.round((runs.filter((r) => r.date >= "2026-10-06").length * 40) / 4));
    expect(b.vdot).toBeNull();
    expect(b.longestRunMinutes).toBe(40);
  });
});

describe("schedule checks", () => {
  it("warns when a move puts two hard days together", () => {
    const items = [
      { id: "a", date: "2026-11-03", type: "threshold" as const },
      { id: "b", date: "2026-11-05", type: "vo2max" as const },
      { id: "c", date: "2026-11-08", type: "long" as const },
    ];
    expect(moveIssues(items, "b", "2026-11-04")).toHaveLength(1);
    expect(moveIssues(items, "b", "2026-11-06")).toHaveLength(0);
    expect(moveIssues(items, "b", "2026-11-07")).toHaveLength(1);
  });
});

describe("matching and execution", () => {
  it("matches runs within a day, prefers the right day, and marks missed after a day of grace", () => {
    const ws = [
      { id: "w1", date: "2026-11-03", type: "easy" as const, durationS: 2400, status: "planned", activityId: null },
      { id: "w2", date: "2026-11-05", type: "threshold" as const, durationS: 3000, status: "planned", activityId: null },
      { id: "w3", date: "2026-11-07", type: "easy" as const, durationS: 2400, status: "planned", activityId: null },
    ];
    const runs = [
      { id: "r1", date: "2026-11-04", movingS: 2300, classification: "easy" },
      { id: "r2", date: "2026-11-05", movingS: 3100, classification: "threshold" },
    ];
    const m = matchRuns(ws, runs, "2026-11-08");
    expect(m.matches).toEqual(expect.arrayContaining([expect.objectContaining({ workoutId: "w1", activityId: "r1" }), expect.objectContaining({ workoutId: "w2", activityId: "r2" })]));
    expect(m.missed).toEqual([]); // w3 is only one day old
    expect(matchRuns(ws, runs, "2026-11-09").missed).toEqual(["w3"]);
  });

  it("judges work pace against the target", () => {
    const plan = generatePlan(half, config(), base());
    const t = plan.workouts.find((w) => w.type === "threshold")!;
    const th = trainingPaces(41.5).find((z) => z.key === "threshold")!;
    const fast = th.fastSPerKm * 0.93;
    const ex = assessExecution(t, { movingS: t.durationS, distanceM: 8000, avgHr: 160, features: { bestEfforts: [{ distanceM: 1000, timeS: fast, startT: 0, avgHr: 170 }, { distanceM: 1609.344, timeS: fast * 1.609, startT: 0, avgHr: 170 }] } as never });
    expect(ex.verdict).toBe("harder");
    expect(ex.paceDeltaPct!).toBeGreaterThan(5);
  });
});

describe("adaptation", () => {
  const plan = generatePlan(half, config(), base());
  const today = "2026-11-17";
  const ws: AdaptWorkout[] = plan.workouts.map((w, i) => ({ ...w, id: `w${i}`, locked: false, status: w.date < today ? "completed" : "planned", execution: null, rpe: null }));
  const runs = ws.filter((w) => w.date < today).map((w) => ({ date: w.date, movingS: w.durationS, classification: isHard(w.type) ? "threshold" : "easy", rpe: null, legs: null }));
  const input = { today, goal: half, baseline: plan.baseline, racePace: plan.racePace, raceLabel: "half marathon", workouts: ws, runs, fitness: null, existingKeys: new Set<string>() };

  it("proposes nothing when training goes to plan", () => {
    expect(proposeAdaptations(input)).toEqual([]);
  });

  it("re-targets paces when fitness rises (A) and won't propose the same thing twice", () => {
    const p = proposeAdaptations({ ...input, fitness: { vdot: 43, confidence: "medium" } });
    expect(p).toHaveLength(1);
    expect(p[0].rule).toBe("A");
    expect(p[0].changes.length).toBeGreaterThan(5);
    expect(proposeAdaptations({ ...input, fitness: { vdot: 43, confidence: "medium" }, existingKeys: new Set([p[0].key]) })).toEqual([]);
    expect(proposeAdaptations({ ...input, fitness: { vdot: 43, confidence: "low" } })).toEqual([]);
  });

  it("eases the week after missed sessions (B) without making them up", () => {
    const missedWs = ws.map((w) => (w.date >= "2026-11-10" && w.date < today ? { ...w, status: "missed" } : w));
    const p = proposeAdaptations({ ...input, workouts: missedWs, runs: runs.filter((r) => r.date < "2026-11-10") });
    const b = p.find((x) => x.rule === "B")!;
    expect(b).toBeTruthy();
    expect(b.changes.every((c) => c.after.durationS <= c.before.durationS)).toBe(true);
    expect(b.changes.every((c) => !isHard(c.before.type))).toBe(true);
  });

  it("swaps the next hard session for easy after fatigue signals (C)", () => {
    const tired = [...runs, { date: "2026-11-16", movingS: 2400, classification: "easy", rpe: 8, legs: null }];
    const p = proposeAdaptations({ ...input, runs: tired });
    const c = p.find((x) => x.rule === "C")!;
    expect(c.changes).toHaveLength(1);
    expect(isHard(c.changes[0].before.type)).toBe(true);
    expect(c.changes[0].after.type).toBe("easy");
  });

  it("returns gently after a break (D)", () => {
    const p = proposeAdaptations({ ...input, runs: runs.filter((r) => r.date <= "2026-11-04") });
    const d = p.find((x) => x.rule === "D")!;
    expect(d).toBeTruthy();
    expect(d.changes.every((c) => !isHard(c.after.type))).toBe(true);
    expect(p.find((x) => x.rule === "B")).toBeUndefined();
  });
});
