import { describe, expect, it } from "vitest";
import { addDaysIso, weekStart } from "@/lib/dates";
import { predictTimeS, trainingPaces, vdotFromPerformance } from "@/lib/analytics/fitness/vdot";
import { scoreRun, type RunRecord } from "@/lib/analytics/fitness/scoring";
import type { RunFeatures } from "@/lib/analytics/fitness/features";
import type { Physiology } from "@/lib/analytics/fitness/physiology";
import { ACWR_MAX, SPIKE_MAX, generatePlan } from "@/lib/planning/generator";
import { buildBaseline, type BaselineFitness, type BaselineRun } from "@/lib/planning/baseline";
import { assessExecution, matchScore } from "@/lib/planning/match";
import { stepsDistance, timeTrialPace } from "@/lib/planning/workouts";
import type { Baseline, Goal, PlanConfig, PlannedWorkout, Step } from "@/lib/planning/types";

const AS_OF = "2026-11-02"; // a Monday
const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
const dow = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** 8 weeks of running: `perWeek` runs of `km` at `pace` s/km, plus a long run on Sundays. */
function history(perWeek: number, km: number, pace: number, longKm: number): BaselineRun[] {
  const runs: BaselineRun[] = [];
  const ws = weekStart(AS_OF);
  for (let w = 1; w <= 8; w++) {
    const s = addDaysIso(ws, -7 * w);
    for (let k = 0; k < perWeek - 1; k++) runs.push({ date: addDaysIso(s, 1 + 2 * k), distanceM: km * 1000, movingS: km * pace });
    runs.push({ date: addDaysIso(s, 6), distanceM: longKm * 1000, movingS: longKm * pace });
  }
  return runs;
}

const fitness = (vdot: number): BaselineFitness => ({
  estimate: { withheld: false, vdot, lower: vdot - 2, upper: vdot + 2, confidence: "medium" },
  paceZones: trainingPaces(vdot),
  hrZones: null,
  threshold: null,
  predictions: [5000, 10000, 21097.5, 42195].map((d) => ({ distanceM: d, timeS: predictTimeS(vdot, d) })),
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
  includeStrides: false,
  baselineTimeTrial: true,
  ...over,
});
const goal = (kind: Goal["kind"], raceDate: string | null = "2027-03-14"): Goal => ({ kind, name: null, distanceM: null, raceDate, targetTimeS: null, targetWeeklyKm: null });

const tts = (ws: PlannedWorkout[]) => ws.filter((w) => w.type === "time_trial");
const mainStep = (w: PlannedWorkout) => w.steps.find((s): s is Exclude<Step, { kind: "repeat" }> => s.kind === "run" && !!s.distanceM)!;

describe("baseline time trial", () => {
  const b = buildBaseline(AS_OF, fitness(42), history(4, 8, 360, 14));

  it("is left out unless chosen", () => {
    expect(tts(generatePlan(goal("half"), config({ baselineTimeTrial: undefined }), b).workouts)).toHaveLength(0);
    expect(tts(generatePlan(goal("half"), config({ baselineTimeTrial: false }), b).workouts)).toHaveLength(0);
  });

  it("puts one time trial in week 1, clear of the long run, with a warm-up and cool-down", () => {
    const p = generatePlan(goal("half"), config(), b);
    const t = tts(p.workouts);
    expect(t).toHaveLength(1);
    const w = t[0];
    expect(w.date >= p.weeks[0].start && w.date <= addDaysIso(p.weeks[0].start, 6)).toBe(true);
    expect(w.date >= "2026-11-03").toBe(true);
    const long = p.workouts.find((x) => (x.type === "long" || x.type === "progressive_long") && x.date <= addDaysIso(p.weeks[0].start, 6));
    if (long) expect(gap(dow(w.date), dow(long.date))).toBeGreaterThanOrEqual(2);
    // no other hard session the day before or after
    for (const x of p.workouts.filter((x) => x !== w && ["threshold", "tempo", "vo2max", "repetitions", "hills", "race_pace"].includes(x.type))) {
      expect(Math.abs(Date.parse(x.date) - Date.parse(w.date))).toBeGreaterThanOrEqual(2 * 864e5);
    }
    expect(w.steps[0].kind).toBe("warmup");
    expect(w.steps.at(-1)!.kind).toBe("cooldown");
    expect(w.key).toBe(true);
    expect(mainStep(w).kind === "run" && mainStep(w).distanceM).toBe(5000);
    expect(w.title).toBe("Time trial: 5 km");
    expect(p.config.baselineTimeTrial).toBe(true);
  });

  it("is 3 km for a 5 km goal and for someone who runs little", () => {
    const p5 = generatePlan(goal("5k"), config(), b);
    expect(tts(p5.workouts)[0].title).toBe("Time trial: 3 km");
    const low = buildBaseline(AS_OF, fitness(38), history(2, 4, 400, 5));
    const pl = generatePlan(goal("10k"), config(), low);
    const t = tts(pl.workouts);
    expect(t).toHaveLength(1);
    expect(t[0].title).toBe("Time trial: 3 km");
  });

  it("shows a target pace and finish time from the fitness estimate", () => {
    const w = tts(generatePlan(goal("half"), config(), b).workouts)[0];
    const pace = predictTimeS(42, 5000) / 5;
    const s = mainStep(w);
    expect(s.kind).toBe("run");
    if (s.kind !== "run") return;
    expect(((s.target.paceFast! + s.target.paceSlow!) / 2)).toBeCloseTo(pace, -1);
    expect(s.target.label).toMatch(/^Time trial · \d+:\d\d–\d+:\d\d\/km$/);
    expect(w.objective).toMatch(/^Target \d+:\d\d/);
  });

  it("without an estimate, the target comes from your best recent run; with no run data there is no target", () => {
    const runs = history(4, 8, 360, 14);
    runs.push({ date: addDaysIso(AS_OF, -3), distanceM: 6000, movingS: 6 * 300 }); // a quick 6 km
    const nb = buildBaseline(AS_OF, null, runs);
    expect(nb.vdot).toBeNull();
    const pace = timeTrialPace(nb, 5000)!;
    expect(pace).toBeCloseTo(predictTimeS(vdotFromPerformance(6000, 1800), 5000) / 5, 0);
    const w = tts(generatePlan(goal("10k"), config(), nb).workouts)[0];
    const s = mainStep(w);
    if (s.kind === "run") expect(s.target.paceFast).toBeGreaterThan(0);

    // runs with a duration but no distance (e.g. a watch without GPS): the trial is planned, without a target
    const noDist: Baseline = buildBaseline(AS_OF, null, history(4, 8, 360, 14).map((r) => ({ ...r, distanceM: null })));
    expect(timeTrialPace(noDist, 5000)).toBeNull();
    const we = tts(generatePlan(goal("10k"), config(), noDist).workouts);
    expect(we).toHaveLength(1);
    const se = mainStep(we[0]);
    expect(se.kind === "run" && se.target.paceFast).toBeNull();
    expect(se.kind === "run" && se.target.paceSlow).toBeNull();
    expect(we[0].objective).toBe("Baseline");
  });

  it("keeps week 1 within the load caps", () => {
    for (const [g, bl] of [
      [goal("half"), b],
      [goal("10k"), b],
      [goal("marathon", "2027-05-01"), buildBaseline(AS_OF, fitness(48), history(5, 10, 320, 20))],
      [goal("general", null), buildBaseline(AS_OF, fitness(36), history(3, 5, 420, 8))],
    ] as const) {
      const p = generatePlan(g, config(), bl);
      const recent = bl.recentWeeks!;
      const chronic = recent.reduce((a, x) => a + x, 0) / 4;
      expect(p.weeks[0].targetMinutes).toBeLessThanOrEqual(Math.max(chronic * ACWR_MAX + 10, Math.max(...recent)) * 1.05 + 5);
      // single-run spike limit, measured as the generator does: distance at your easy pace
      const ez = bl.paceZones!.find((z) => z.key === "easy")!;
      const easy = (ez.fastSPerKm + ez.slowSPerKm) / 2;
      const biggest = Math.max(...bl.recentRuns!.filter((r) => r.date >= addDaysIso(p.weeks[0].start, -24)).map((r) => (r.km! * easy) / 60));
      for (const w of tts(p.workouts)) expect(((stepsDistance(w.steps)! / 1000) * easy) / 60).toBeLessThanOrEqual(Math.floor(SPIKE_MAX * biggest) + 1);
    }
  });

  it("drops the trial when even 3 km with a warm-up would be too big a single run", () => {
    // short jogs only: 3–3.5 km
    const small = buildBaseline(AS_OF, fitness(45), history(4, 3, 330, 3.5));
    expect(tts(generatePlan(goal("half"), config(), small).workouts)).toHaveLength(0);
  });
});

describe("a completed time trial", () => {
  const b = buildBaseline(AS_OF, fitness(42), history(4, 8, 360, 14));
  const w = tts(generatePlan(goal("half"), config(), b).workouts)[0];
  const feats = (timeS: number) => ({ bestEfforts: [{ distanceM: 1000, timeS: timeS / 5 - 5, avgHr: 170 }, { distanceM: 5000, timeS, avgHr: 172 }] }) as unknown as RunFeatures;

  it("records the target against the time you ran", () => {
    const ex = assessExecution(w, { movingS: w.durationS, distanceM: 9000, avgHr: 170, features: feats(1500) });
    expect(ex.timeTrial).toBeDefined();
    expect(ex.timeTrial!.distanceM).toBe(5000);
    expect(ex.timeTrial!.actualS).toBe(1500);
    expect(ex.timeTrial!.targetS).toBeCloseTo(predictTimeS(42, 5000), -1);
    expect(ex.notes[0]).toMatch(/^5 km in 25:00 \(target/);
  });

  it("matches like a hard session", () => {
    const wk = { id: "w", date: w.date, type: w.type, durationS: w.durationS, status: "planned", activityId: null };
    expect(matchScore(wk, { id: "r", date: w.date, movingS: w.durationS, classification: "race" })).toBeGreaterThan(matchScore(wk, { id: "r", date: w.date, movingS: w.durationS, classification: "easy" }));
  });

  it("counts as race evidence in the fitness model, unless it was clearly run easy", () => {
    const phys: Physiology = { maxHr: { value: 190, source: "manual", note: "" }, restHr: { value: 50, source: "manual", note: "" }, trimpK: { a: 0.64, b: 1.92, note: "" } };
    const run = (hr: number, plannedTimeTrial: boolean): RunRecord => ({
      id: "r",
      date: w.date,
      name: "Morning run",
      distanceM: 5000,
      movingS: 1500,
      avgHr: hr,
      paceReliable: true,
      hrReliable: true,
      usableForFitness: true,
      isIndoor: false,
      classificationOverride: null,
      plannedTimeTrial,
      features: {
        movingS: 1500,
        steady: { movingS: 1500, distanceM: 5000, avgHr: hr, gainPerKm: 2 },
        speedCv: 0.12,
        fastBouts: 0,
        hrHist: [],
        hrHistOffset: 0,
        bestEfforts: [{ distanceM: 5000, timeS: 1500, avgHr: hr }],
      } as unknown as RunFeatures,
    });
    // HR at 86 % of reserve with uneven pacing would otherwise read as a threshold run
    expect(scoreRun(run(170, false), phys, { vdot: null, medianRecentMovingS: null }).classification).toBe("threshold");
    expect(scoreRun(run(170, true), phys, { vdot: null, medianRecentMovingS: null }).classification).toBe("race");
    // jogged at 65 % of reserve: not a time trial, whatever the plan said
    expect(scoreRun(run(128, true), phys, { vdot: null, medianRecentMovingS: null }).classification).not.toBe("race");
  });
});
