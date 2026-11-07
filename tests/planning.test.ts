import { describe, expect, it } from "vitest";
import { addDaysIso } from "@/lib/dates";
import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { ACWR_MAX, HARD_SHARE_MAX, SPIKE_MAX, generatePlan, hardMinutes, pickQualityDays, spreadDays } from "@/lib/planning/generator";
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

/**
 * The weekly load rules: week 1 at most the larger of 1.3× the 4-week average + 10 min and the best recent week; after
 * that a loading week grows at most 10 % (or 10 min), plus one short easy run (≤ 30 min) when a run is added.
 * 5 % slack for the week-fitting tolerance, 3 min for rounding.
 */
function expectLoadRules(p: ReturnType<typeof generatePlan>, chronic: number, best: number) {
  expect(p.weeks[0].targetMinutes).toBeLessThanOrEqual(Math.max(chronic * ACWR_MAX + 10, best) * 1.05 + 3);
  const load = p.weeks.filter((w) => ["base", "build", "specific"].includes(w.phase)).map((w) => w.targetMinutes);
  for (let i = 1; i < load.length; i++) expect(load[i]).toBeLessThanOrEqual((Math.max(load[i - 1] * 1.1, load[i - 1] + 10) + 30) * 1.05 + 3);
}

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

  it("starts near what you run now and limits week-to-week increases", () => {
    expectLoadRules(p, 50, 50);
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
    const quiet = generatePlan(tenK, all, base({ ...low, recentWeeks: [50, 50, 50, 50], recentRunCounts: [2, 2, 2, 2] }));
    const keen = generatePlan(tenK, all, base({ ...low, weeklyMinutes: 120, recentWeeks: [100, 110, 125, 140], recentRunCounts: [3, 4, 4, 4], runsPerWeek: 3.75 }));
    expect(keen.weeks[0].targetMinutes).toBeGreaterThan(quiet.weeks[0].targetMinutes * 1.7);
    expect(keen.weeks[0].targetMinutes).toBeLessThanOrEqual(Math.max(140, 119 * ACWR_MAX) + 20);
    const n = (p: typeof keen) => p.workouts.filter((x) => x.date <= addDaysIso(p.weeks[0].start, 6)).length;
    expect(n(keen)).toBeGreaterThan(n(quiet));
  });

  it("takes run frequency and length from your history, not a default", () => {
    const firstWeek = (pl: ReturnType<typeof generatePlan>) => pl.workouts.filter((x) => x.date <= addDaysIso(pl.weeks[0].start, 6)).length;
    const sixDay = generatePlan(tenK, all, base({ weeklyMinutes: 270, runsPerWeek: 6, consistency: 1, longestRunMinutes: 90, recentWeeks: [265, 270, 275, 270], recentRunCounts: [6, 6, 6, 6], habitualRunMinutes: 45 }));
    expect(firstWeek(sixDay)).toBeGreaterThanOrEqual(5);
    expect(firstWeek(sixDay)).toBeLessThanOrEqual(7);
    expect(sixDay.weeks[0].targetMinutes).toBeGreaterThan(250);
    const nothing = generatePlan(tenK, all, base({ weeklyMinutes: 0, runsPerWeek: 0, consistency: 0, longestRunMinutes: 0, recentWeeks: [0, 0, 0, 0], recentRunCounts: [0, 0, 0, 0], habitualRunMinutes: null }));
    // starting from nothing: three short runs (a couch-to-5k-like week)
    expect(firstWeek(nothing)).toBe(3);
    expect(nothing.weeks[0].targetMinutes).toBeLessThanOrEqual(80);
  });

  it("never plans a run more than 10 % longer than the longest in the previous 30 days", () => {
    for (const pl of [p, generatePlan(half, config(), base({ longestRun30Minutes: 60 }))]) {
      const ref = pl.baseline.longestRun30Minutes ?? pl.baseline.longestRunMinutes;
      for (const w of pl.workouts) {
        if (w.type === "race") continue;
        const prior = pl.workouts.filter((x) => x.type !== "race" && x.date < w.date && x.date >= addDaysIso(w.date, -30)).map((x) => x.durationS / 60);
        const within = w.date <= addDaysIso(pl.baseline.asOf, 30) ? [ref] : [];
        expect(w.durationS / 60).toBeLessThanOrEqual(Math.max(30, SPIKE_MAX * Math.max(...prior, ...within, 0)) + 1);
      }
    }
  });

  it("tapers volume by 40–60 % over two weeks and keeps your run frequency", () => {
    const peak = Math.max(...p.weeks.map((w) => w.targetMinutes));
    const [taper, race] = p.weeks.slice(-2);
    expect(taper.phase).toBe("taper");
    expect(taper.targetMinutes / peak).toBeLessThanOrEqual(0.8);
    const raceRun = p.workouts.find((x) => x.type === "race")!;
    expect((race.targetMinutes - raceRun.durationS / 60) / peak).toBeLessThanOrEqual(0.5);
    const count = (w: (typeof p.weeks)[number]) => p.workouts.filter((x) => x.date >= w.start && x.date <= addDaysIso(w.start, 6)).length;
    const lastBuild = p.weeks.filter((w) => w.phase === "specific").at(-1)!;
    expect(count(taper)).toBeGreaterThanOrEqual(count(lastBuild));
    expect(count(race)).toBeGreaterThanOrEqual(count(lastBuild) - 1);
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

  it("also eases a hard session when HRV is below your normal range (C)", () => {
    const hrv = Array.from({ length: 40 }, (_, i) => ({ date: addDaysIso(today, -(39 - i)), metric: "hrv_overnight_avg", value: i >= 34 ? 45 : 60 + [0, 3, -2, 4, -3, 1, -1, 2][i % 8] }));
    const c = proposeAdaptations({ ...input, wellness: hrv }).find((x) => x.rule === "C")!;
    expect(c).toBeTruthy();
    expect(c.explanation).toMatch(/HRV is outside your normal range/);
    expect(c.evidence.join(" ")).toMatch(/HRV: 7-day average/);
  });

  it("returns gently after a break (D)", () => {
    const p = proposeAdaptations({ ...input, runs: runs.filter((r) => r.date <= "2026-11-04") });
    const d = p.find((x) => x.rule === "D")!;
    expect(d).toBeTruthy();
    expect(d.changes.every((c) => !isHard(c.after.type))).toBe(true);
    expect(p.find((x) => x.rule === "B")).toBeUndefined();
  });
});

describe("runs per week: fixed or auto", () => {
  const low = base({ weeklyMinutes: 50, runsPerWeek: 1.5, consistency: 0.75, longestRunMinutes: 61, recentWeeks: [50, 50, 50, 50], recentRunCounts: [1, 2, 1, 2] });
  const tenK: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-04-24", targetTimeS: null, targetWeeklyKm: null };
  const runs = (pl: ReturnType<typeof generatePlan>) => pl.weeks.map((w) => pl.workouts.filter((x) => x.type !== "rest" && x.date >= w.start && x.date <= addDaysIso(w.start, 6)).length);

  it("uses the number you chose once the week has room for it, never more, and keeps it", () => {
    const p = generatePlan(tenK, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 6, runsPerWeek: 3 }), low);
    const counts = runs(p);
    counts.forEach((c) => expect(c).toBeLessThanOrEqual(3));
    // from the first build week on, every week has exactly 3
    const firstBuild = p.weeks.findIndex((w) => w.phase === "build");
    counts.slice(firstBuild, -1).forEach((c) => expect(c).toBe(3));
    // a run once added stays in the loading weeks
    const load = p.weeks.map((w, i) => (["base", "build", "specific"].includes(w.phase) ? counts[i] : null)).filter((c) => c != null) as number[];
    for (let i = 1; i < load.length; i++) expect(load[i]).toBeGreaterThanOrEqual(load[i - 1]);
  });

  it("keeps the same load limits whatever the frequency, and says when runs join later", () => {
    const four = generatePlan(tenK, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 6, runsPerWeek: 4 }), low);
    expectLoadRules(four, 50, 50);
    expect(Math.max(...runs(four))).toBe(4);
    expect(runs(four)[0]).toBeLessThan(4);
    expect(four.warnings.some((w) => w.includes("adds them as your weekly running grows"))).toBe(true);
  });

  it("never uses more days than you ticked, and warns", () => {
    const p = generatePlan(tenK, config({ runDays: [1, 3], longRunDay: 3, runsPerWeek: 4 }), low);
    runs(p).slice(0, -1).forEach((c) => expect(c).toBeLessThanOrEqual(2));
    expect(p.warnings.some((w) => w.includes("ticked 2 days"))).toBe(true);
  });

  it("auto uses a frequency you enter instead of the measured one", () => {
    const none = base({ weeklyMinutes: 0, runsPerWeek: 0, consistency: 0, longestRunMinutes: 0, recentWeeks: [0, 0, 0, 0], recentRunCounts: [0, 0, 0, 0], habitualRunMinutes: null });
    const measured = generatePlan(tenK, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 6 }), base({ ...none, weeklyMinutes: 200, recentWeeks: [200, 200, 200, 200] }));
    const told = generatePlan(tenK, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 6, usualRunsPerWeek: 5 }), base({ ...none, weeklyMinutes: 200, recentWeeks: [200, 200, 200, 200] }));
    expect(runs(told)[0]).toBeGreaterThan(runs(measured)[0]);
    expect(runs(told)[0]).toBeLessThanOrEqual(7);
  });
});

describe("sessions seeded from your own runs (planner@3)", () => {
  // Trym's last 8 weeks before 2026-11-05: mostly 4.5–7 km, with recent long runs of 10.05 km and 8.65 km
  const raw: [string, number, number][] = [
    ["2026-09-13", 6.09, 34], ["2026-09-15", 5.61, 39], ["2026-09-26", 5.35, 31], ["2026-10-05", 6.27, 31], ["2026-10-08", 10.05, 61],
    ["2026-10-17", 5.44, 29], ["2026-10-21", 7.01, 39], ["2026-10-23", 4.61, 23], ["2026-11-01", 8.65, 45], ["2026-11-02", 4.73, 31],
  ];
  const real = raw.map(([date, km, min]) => ({ date, distanceM: km * 1000, movingS: min * 60 }));
  const fit = {
    estimate: { withheld: false, vdot: 41.5, lower: 41.5, upper: 44, confidence: "medium" as const },
    paceZones: trainingPaces(41.5),
    hrZones,
    threshold: { hr: 175 },
    predictions: [5000, 10000, 21097.5, 42195].map((d) => ({ distanceM: d, timeS: predictTimeS(41.5, d) })),
  };
  const b = buildBaseline("2026-11-05", fit, real);
  const tenK: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-04-24", targetTimeS: null, targetWeeklyKm: null };
  const p = generatePlan(tenK, config({ startDate: "2026-11-05", runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 3, runsPerWeek: 3 }), b);
  const isLong = (t: string) => t === "long" || t === "progressive_long";
  const km = (w: { distanceM: number | null }) => (w.distanceM ?? 0) / 1000;
  const weekOf = (w: (typeof p.weeks)[number]) => p.workouts.filter((x) => x.date >= w.start && x.date <= addDaysIso(w.start, 6));

  it("keeps your recent runs in the baseline", () => {
    expect(b.recentRuns?.length).toBe(raw.length);
    expect(b.recentRuns?.at(-1)).toEqual({ date: "2026-11-02", minutes: 31, km: 4.73 });
  });

  it("starts week 1 at about your best recent week (~16.6 km here), not far above it", () => {
    const w1 = p.workouts.filter((x) => x.date <= addDaysIso(p.weeks[0].start, 6)).reduce((a, x) => a + km(x), 0);
    expect(w1).toBeLessThanOrEqual(16.6 * 1.05 + 0.5);
    expect(w1).toBeGreaterThanOrEqual(14);
  });

  it("starts the long run from your recent long runs, within 10 % of your longest in the last 30 days", () => {
    const first = p.workouts.find((w) => isLong(w.type))!;
    // a little under your recent long runs while the week around it is still small
    expect(km(first)).toBeGreaterThanOrEqual(7);
    expect(km(first)).toBeLessThanOrEqual(8.65 * 1.1 + 0.1);
    expect(first.why).toMatch(/10 km and 8\.7 km/);
  });

  it("makes the long run clearly longer than the other runs", () => {
    for (const w of p.weeks.filter((x) => ["base", "build", "specific"].includes(x.phase))) {
      const ws = weekOf(w);
      const long = ws.find((x) => isLong(x.type))!;
      for (const e of ws.filter((x) => x.type === "easy" || x.type === "strides" || x.type === "recovery")) expect(long.durationS).toBeGreaterThanOrEqual(e.durationS * 1.4);
    }
  });

  it("builds the long run to about 1.2× race distance (steady) by the end of the build phase, holds it, then tapers", () => {
    const longs = p.workouts.filter((w) => isLong(w.type));
    const top = Math.max(...longs.map(km));
    expect(top).toBeGreaterThanOrEqual(11);
    expect(top).toBeLessThanOrEqual(12.5);
    const lastBuild = p.weeks.filter((w) => w.phase === "build").at(-1)!;
    const peakAt = longs.find((w) => km(w) === top)!;
    expect(peakAt.date <= addDaysIso(lastBuild.start, 6)).toBe(true);
    const taperLong = weekOf(p.weeks.find((w) => w.phase === "taper")!).find((x) => isLong(x.type))!;
    expect(km(taperLong)).toBeLessThanOrEqual(top * 0.7);
  });

  it("never plans a run more than 10 % further than the furthest in the previous 30 days (real runs included)", () => {
    const all = [...real.filter((r) => r.movingS >= 600).map((r) => ({ date: r.date, km: r.distanceM / 1000 })), ...p.workouts.filter((w) => w.type !== "race").map((w) => ({ date: w.date, km: km(w) }))];
    for (const w of p.workouts.filter((x) => x.type !== "race")) {
      const prior = all.filter((x) => x.date < addDaysIso(w.date, -6) && x.date >= addDaysIso(w.date, -30)).map((x) => x.km);
      expect(km(w)).toBeLessThanOrEqual(1.1 * Math.max(...prior, 0) + 0.15);
    }
  });

  it("alternates the phase's session types when there is room for one hard session a week", () => {
    const hard = p.workouts.filter((w) => p.weeks.some((x) => x.phase === "specific" && w.date >= x.start && w.date <= addDaysIso(x.start, 6)) && isHard(w.type));
    expect(new Set(hard.map((w) => w.type)).size).toBeGreaterThanOrEqual(2);
  });

  it("explains the long-run distance for the race", () => {
    expect(p.summary.join(" ")).toMatch(/a little past race distance/);
  });
});

describe("volume and intensity options (planner@3)", () => {
  const raw: [string, number, number][] = [
    ["2026-09-13", 6.09, 34], ["2026-09-15", 5.61, 39], ["2026-09-26", 5.35, 31], ["2026-10-05", 6.27, 31], ["2026-10-08", 10.05, 61],
    ["2026-10-17", 5.44, 29], ["2026-10-21", 7.01, 39], ["2026-10-23", 4.61, 23], ["2026-11-01", 8.65, 45], ["2026-11-02", 4.73, 31],
  ];
  const fit = {
    estimate: { withheld: false, vdot: 41.5, lower: 41.5, upper: 44, confidence: "medium" as const },
    paceZones: trainingPaces(41.5),
    hrZones,
    threshold: { hr: 175 },
    predictions: [5000, 10000, 21097.5, 42195].map((d) => ({ distanceM: d, timeS: predictTimeS(41.5, d) })),
  };
  const b = buildBaseline("2026-11-05", fit, raw.map(([date, km, min]) => ({ date, distanceM: km * 1000, movingS: min * 60 })));
  const tenK: Goal = { kind: "10k", name: null, distanceM: null, raceDate: "2027-04-24", targetTimeS: 2700, targetWeeklyKm: null };
  const mk = (over: Partial<PlanConfig>) => generatePlan(tenK, config({ startDate: "2026-11-05", runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 3, runsPerWeek: 3, ...over }), b);
  const weekKm = (p: ReturnType<typeof generatePlan>) =>
    p.weeks.map((w) => p.workouts.filter((x) => x.date >= w.start && x.date <= addDaysIso(w.start, 6)).reduce((a, x) => a + (x.distanceM ?? 0), 0) / 1000);
  const peakKm = (p: ReturnType<typeof generatePlan>) => Math.max(...weekKm(p).slice(0, -1));
  const longKm = (p: ReturnType<typeof generatePlan>) => Math.max(...p.workouts.filter((w) => w.type === "long" || w.type === "progressive_long").map((w) => (w.distanceM ?? 0) / 1000));

  it("peaks at a realistic volume for 3 runs a week and then holds, instead of growing every week", () => {
    const p = mk({});
    expect(peakKm(p)).toBeLessThanOrEqual(30);
    expect(peakKm(p)).toBeGreaterThanOrEqual(22);
    // the last 8 loading weeks stay within ~15 % of each other: a plateau, not a climb
    const load = weekKm(p).filter((_, i) => ["base", "build", "specific"].includes(p.weeks[i].phase)).slice(-8);
    expect(Math.max(...load) / Math.min(...load)).toBeLessThan(1.2);
  });

  it("orders gradual < steady < progressive in peak volume and long run", () => {
    const [g, s, pr] = (["gradual", "steady", "progressive"] as const).map((v) => mk({ volume: v }));
    expect(peakKm(g)).toBeLessThan(peakKm(s));
    expect(peakKm(s)).toBeLessThan(peakKm(pr));
    expect(longKm(g)).toBeLessThanOrEqual(11.3);
    expect(longKm(s)).toBeLessThanOrEqual(12.5);
    expect(longKm(pr)).toBeLessThanOrEqual(14.5);
    expect(longKm(pr)).toBeGreaterThan(longKm(g));
    // gradual takes a lighter week every 3 weeks
    expect(g.weeks.slice(0, 3).map((w) => w.phase)).toContain("recovery");
  });

  it("comfortable leaves out the fastest sessions; challenging has more hard sessions than balanced", () => {
    const hard = (p: ReturnType<typeof generatePlan>) => p.workouts.filter((w) => isHard(w.type) && w.type !== "race");
    const comfy = mk({ intensity: "comfortable" });
    expect(hard(comfy).some((w) => w.type === "vo2max" || w.type === "repetitions")).toBe(false);
    expect(hard(mk({ intensity: "challenging" })).length).toBeGreaterThan(hard(mk({})).length);
    expect(hard(comfy).length).toBeLessThanOrEqual(hard(mk({})).length);
  });

  it("keeps every week inside the load rules for every option", () => {
    for (const volume of ["gradual", "steady", "progressive"] as const)
      for (const runsPerWeek of [2, 3, 4, 5]) {
        const p = mk({ volume, runsPerWeek });
        const load = p.weeks.filter((w) => ["base", "build", "specific"].includes(w.phase)).map((w) => w.targetMinutes);
        for (let i = 1; i < load.length; i++) expect(load[i]).toBeLessThanOrEqual(Math.max(load[i - 1] * 1.13, load[i - 1] + 10) * 1.05 + 3);
        expect(validateSchedule(p.workouts)).toEqual([]);
      }
  });

  it("auto picks one more run than you do now (at least 3) and keeps it", () => {
    const p = mk({ runsPerWeek: null });
    const counts = p.weeks.slice(0, -1).map((w) => p.workouts.filter((x) => x.date >= w.start && x.date <= addDaysIso(w.start, 6)).length);
    expect(Math.max(...counts)).toBe(3);
  });
});

describe("long-run day left to the planner", () => {
  const dow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  const p = generatePlan(half, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: null, runsPerWeek: 3 }), base());

  it("keeps the setting as best fit so a recalculation picks again", () => {
    expect(p.config.longRunDay).toBeNull();
  });

  it("puts every long run on one day, with no run the day after", () => {
    const longs = p.workouts.filter((w) => w.type === "long" || w.type === "progressive_long");
    expect(longs.length).toBeGreaterThan(3);
    const days = new Set(longs.map((w) => dow(w.date)));
    expect(days.size).toBe(1);
    const d = [...days][0];
    for (const l of longs) expect(p.workouts.some((w) => w.date === addDaysIso(l.date, 1))).toBe(false);
    expect([5, 6]).toContain(d);
  });

  it("still uses a day you chose", () => {
    const fixed = generatePlan(half, config({ runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay: 2, runsPerWeek: 3 }), base());
    expect(fixed.config.longRunDay).toBe(2);
    expect(fixed.workouts.filter((w) => w.type === "long").every((w) => dow(w.date) === 2)).toBe(true);
  });
});
