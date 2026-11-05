/**
 * Deterministic plan generator (`planner@2`). Pure: goal + availability +
 * baseline in, dated structured workouts out. Every rule here is documented
 * in docs/PLANNING.md; no LLM is involved.
 */
import { addDaysIso, daysBetween, weekStart } from "../dates";
import { predictTimeS } from "../analytics/fitness/vdot";
import { fmtTime } from "../analytics/fitness/estimate";
import { formatPace } from "../units";
import {
  GOAL_DISTANCE,
  GOAL_LABEL,
  PLANNER_VERSION,
  isHard,
  type Baseline,
  type GeneratedPlan,
  type Goal,
  type GoalKind,
  type Phase,
  type PlanConfig,
  type PlanWeek,
  type PlannedWorkout,
  type Step,
  type WorkoutType,
} from "./types";
import { buildWorkout, finalize, stepsDistance, stepsDuration, type TargetContext } from "./workouts";
import { project, volumeFactor, type Projection } from "./projection";

export const MIN_WEEKS = 2;
export const MAX_WEEKS = 24;

/** Highest weekly running time the plan builds to, by goal (minutes). */
const PEAK_MINUTES: Record<string, number> = { "5k": 240, "10k": 300, half: 360, marathon: 480, race: 360, general: 300, endurance: 360, consistency: 240, maintain: 300, volume: 420 };
/** Longest long run, minutes. */
const LONG_CAP: Record<string, number> = { "5k": 75, "10k": 90, half: 120, marathon: 150, race: 120, general: 90, endurance: 120, consistency: 75, maintain: 90, volume: 120 };
/** Weeks of taper including race week. */
// ~2 weeks is the best-supported taper length (Bosquet 2007; 2023 endurance meta-analysis), 3 for the marathon
const TAPER_WEEKS: Record<string, number> = { "5k": 2, "10k": 2, half: 2, marathon: 3, race: 2 };
/** Taper volume as a share of peak: a progressive 40–60 % cut, intensity and frequency kept. */
const TAPER_FACTORS: Record<number, number[]> = { 1: [0.6], 2: [0.75, 0.5], 3: [0.8, 0.6, 0.45] };
/** No single run more than 10 % longer than your longest run in the previous 30 days (Frandsen et al., BJSM 2025). */
export const SPIKE_MAX = 1.1;
/** Floor for the spike limit, so someone with no recent running can still do a 30-minute session. */
const SPIKE_FLOOR_MIN = 30;

export const goalDistance = (g: Goal): number | null => g.distanceM ?? GOAL_DISTANCE[g.kind] ?? null;

/** "5k" | "10k" | "half" | "marathon" bucket for a race distance, used to pick session types. */
export function distanceKey(d: number | null): "5k" | "10k" | "half" | "marathon" | null {
  if (!d) return null;
  if (d <= 7000) return "5k";
  if (d <= 15000) return "10k";
  if (d <= 30000) return "half";
  return "marathon";
}

export function raceLabelFor(goal: Goal): string | null {
  const dk = distanceKey(goalDistance(goal));
  if (!dk) return null;
  return goal.kind === "race" && goal.name ? goal.name : GOAL_LABEL[dk as GoalKind].replace("Improve ", "").toLowerCase();
}

const isRaceGoal = (g: Goal) => goalDistance(g) != null;

/** Pace (s/km) predicted for a distance from the baseline. */
export function predictedPace(b: Baseline, distanceM: number): number | null {
  const exact = b.predictions.find((p) => Math.abs(p.distanceM - distanceM) < 1);
  if (exact) return exact.timeS / (distanceM / 1000);
  if (b.vdot == null) return null;
  return predictTimeS(b.vdot, distanceM) / (distanceM / 1000);
}

interface Pace {
  racePace: number | null;
  note: string | null;
  warning: string | null;
}

/**
 * Race pace for race-specific sessions: your target pace when it is within
 * the projected range, otherwise the projected pace (with a warning).
 */
function choosePace(goal: Goal, b: Baseline, proj: Projection | null): Pace {
  const d = goalDistance(goal);
  if (!d) return { racePace: null, note: null, warning: null };
  const pred = predictedPace(b, d);
  const goalPace = goal.targetTimeS ? goal.targetTimeS / (d / 1000) : null;
  if (pred == null || !proj) {
    return {
      racePace: goalPace,
      note: goalPace ? `Race-pace work uses your target pace ${formatPace(goalPace)}/km; there is no fitness estimate yet to check it against.` : null,
      warning: goalPace ? null : "There is no fitness estimate yet, so race-pace sessions are by effort and heart rate. They get paces once the estimate appears.",
    };
  }
  const projected = proj.projectedS / (d / 1000);
  const optimistic = proj.fastS / (d / 1000);
  if (goalPace == null) {
    return { racePace: Math.round(pred), note: `Race pace ${formatPace(pred)}/km is your current predicted pace; it is recalibrated as your fitness changes.`, warning: null };
  }
  if (goalPace >= optimistic) {
    return { racePace: Math.round(goalPace), note: `Race pace ${formatPace(goalPace)}/km is your target pace (predicted now: ${formatPace(pred)}/km).`, warning: null };
  }
  return {
    racePace: Math.round(projected),
    note: `Race pace ${formatPace(projected)}/km: your projected pace if you follow the plan.`,
    warning: `Your target ${fmtTime(goal.targetTimeS!)} is faster than even the optimistic end of the projection (${fmtTime(proj.fastS)}). The plan trains at ${formatPace(projected)}/km and moves toward your target if your fitness improves faster.`,
  };
}

function planWeeks(goal: Goal, config: PlanConfig): { start: string; weeks: number; warnings: string[] } {
  const warnings: string[] = [];
  let start = weekStart(config.startDate);
  if (goal.raceDate) {
    const raceWeek = weekStart(goal.raceDate);
    let n = Math.floor(daysBetween(start, raceWeek) / 7) + 1;
    // asked to start now (startNow): a longer build is fine, up to a year
    const cap = config.startNow ? 52 : MAX_WEEKS;
    if (n > cap) {
      start = addDaysIso(raceWeek, -7 * (cap - 1));
      warnings.push(`The race is more than ${cap} weeks away, so the plan starts on ${start}. Until then, keep running as you do now.`);
      n = cap;
    }
    if (n < 4) warnings.push(`Only ${n} week${n === 1 ? "" : "s"} until the race: there is no time to build fitness, so this plan keeps you fresh and sharp instead.`);
    return { start, weeks: Math.max(1, n), warnings };
  }
  return { start, weeks: Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, config.weeks)), warnings };
}

function assignPhases(goal: Goal, n: number, lowConsistency: boolean): Phase[] {
  const phases: Phase[] = new Array(n).fill("base");
  const race = isRaceGoal(goal);
  let taper = 0;
  if (race && goal.raceDate) {
    const k = distanceKey(goalDistance(goal))!;
    taper = Math.min(TAPER_WEEKS[k] ?? 2, n);
    for (let i = n - taper; i < n; i++) phases[i] = "taper";
    phases[n - 1] = "race";
  } else if (race) {
    // distance goal without a race: finish with a lighter week and a time trial
    taper = n >= 4 ? 1 : 0;
    if (taper) phases[n - 1] = "race";
  }
  const rest = n - taper;
  if (race) {
    const specific = Math.round(rest * 0.3);
    const build = Math.round(rest * 0.35);
    for (let i = 0; i < rest; i++) phases[i] = i < rest - specific - build ? "base" : i < rest - specific ? "build" : "specific";
  } else if (goal.kind === "general" || goal.kind === "maintain") {
    const base = Math.ceil(rest * 0.4);
    for (let i = 0; i < rest; i++) phases[i] = i < base ? "base" : "build";
  }
  // recovery weeks: every 4th (every 3rd with patchy recent training), never right before the taper
  const every = lowConsistency ? 3 : 4;
  for (let i = every - 1; i < rest - 1; i += every) phases[i] = "recovery";
  return phases;
}

/** Pick `k` of the available days, spread as evenly as possible around the week, keeping the long-run day. */
export function spreadDays(avail: number[], k: number, longDay: number | null): number[] {
  if (k >= avail.length) return [...avail];
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  const combos = (n: number, from = 0, acc: number[] = []): number[][] => (acc.length === n ? [acc] : avail.slice(from).flatMap((d, i) => combos(n, from + i + 1, [...acc, d])));
  let best: number[] = avail.slice(0, k);
  let bestScore = -Infinity;
  for (const c of combos(k)) {
    let minGap = 7;
    let consecutive = 0;
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) {
        const g = gap(c[i], c[j]);
        minGap = Math.min(minGap, g);
        if (g === 1) consecutive++;
      }
    const score = minGap * 100 - consecutive * 10 + (longDay != null && c.includes(longDay) ? 50 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best.sort((a, b) => a - b);
}

/** Minutes of a session spent at threshold effort or harder. */
export function hardMinutes(steps: Step[]): number {
  let s = 0;
  for (const x of steps) {
    if (x.kind === "repeat") s += x.count * hardMinutes(x.steps) * 60;
    else if (["threshold", "interval", "repetition", "race", "hill", "marathon"].includes(x.target.zone)) s += x.durationS ?? 0;
  }
  return s / 60;
}

/** Largest allowed week-over-week step, minutes. */
const weeklyStep = (level: number, low: boolean) => (low ? Math.min(20, Math.max(6, level * 0.06)) : Math.min(30, Math.max(10, level * 0.1)));
/** Acute:chronic workload ratio ceiling (week vs the 4 weeks before it). */
export const ACWR_MAX = 1.3;
/** Share of weekly time at threshold or harder (the "80/20" rule, with some room for warm-ups). */
export const HARD_SHARE_MAX = 0.2;

/** Taper long runs as a share of the longest long run, one per taper week before race week. */
const TAPER_LONG: Record<number, number[]> = { 1: [], 2: [0.65], 3: [0.75, 0.6] };
/**
 * Longest long run as a multiple of the race distance (also capped in minutes by LONG_CAP). 5 and 10 km are
 * ~90 % aerobic, so modest over-distance long runs build the endurance to hold pace to the line; for the half
 * and the marathon the long run approaches or stays under race distance (Daniels, Pfitzinger).
 */
export const LONG_KM_FACTOR: Record<"5k" | "10k" | "half" | "marathon", number> = { "5k": 2.4, "10k": 1.3, half: 1.1, marathon: 0.76 };
/** Easy runs build towards this share of the peak long run (60 min at most), so the long run stays clearly the long one. */
const EASY_OF_LONG = 0.55;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function generatePlan(goal: Goal, config: PlanConfig, baseline: Baseline): GeneratedPlan {
  const warnings: string[] = [];
  const { start, weeks: n, warnings: w0 } = planWeeks(goal, config);
  warnings.push(...w0);
  const lowConsistency = baseline.consistency < 0.6;
  const phases = config.phases && config.phases.length === n ? config.phases : assignPhases(goal, n, lowConsistency);
  const dist = goalDistance(goal);
  const dk = distanceKey(dist);
  if (!baseline.paceZones) warnings.push(baseline.hrZones ? "No fitness estimate yet, so sessions use heart-rate targets only. Paces are added once the estimate is available." : "No fitness estimate or heart-rate zones yet, so sessions are described by effort.");

  // --- days and frequency -------------------------------------------------
  const unavailable = new Set(config.unavailableDays);
  const avail = [...new Set(config.runDays)].filter((d) => d >= 0 && d <= 6 && !unavailable.has(d)).sort((a, b) => a - b);
  if (avail.length === 0) avail.push(1, 3, 5, 6);
  const usual = config.usualRunsPerWeek != null && config.usualRunsPerWeek > 0 ? Math.min(7, config.usualRunsPerWeek) : null;
  const runHist0 = usual != null ? [usual, usual, usual, usual] : baseline.recentRunCounts?.length === 4 ? [...baseline.recentRunCounts] : [1, 1, 1, 1].map(() => Math.round(baseline.runsPerWeek));
  // a fixed number of runs a week, if you chose one (never more than the days you can run)
  const fixedRuns = config.runsPerWeek != null && config.runsPerWeek >= 1 ? Math.min(avail.length, Math.round(config.runsPerWeek)) : null;
  if (fixedRuns != null && config.runsPerWeek! > avail.length) warnings.push(`You asked for ${config.runsPerWeek} runs a week but ticked ${avail.length} days, so the plan uses ${avail.length}.`);
  const longDay = config.includeLongRuns ? (config.longRunDay != null && avail.includes(config.longRunDay) ? config.longRunDay : avail.includes(6) ? 6 : avail.includes(5) ? 5 : avail[avail.length - 1]) : null;

  // --- your running, measured ------------------------------------------------
  // Sizes are "easy minutes": a run's distance at your easy pace when distances and paces are known (the
  // single-run spike rule is about distance, and a fast 8.7 km is as much running as a slow one), else its minutes.
  const easyZone = baseline.paceZones?.find((z) => z.key === "easy");
  const easyPace = easyZone ? (easyZone.fastSPerKm + easyZone.slowSPerKm) / 2 : null;
  const hist = (baseline.recentRuns ?? []).filter((r) => r.minutes >= 10);
  const byDistance = easyPace != null && hist.length > 0 && hist.every((r) => r.km != null && r.km > 0);
  const runSize = (r: { minutes: number; km: number | null }) => (byDistance ? (r.km! * easyPace!) / 60 : r.minutes);
  const stepsSize = (steps: Step[]) => {
    if (byDistance) {
      const d = stepsDistance(steps);
      if (d != null) return ((d / 1000) * easyPace!) / 60;
    }
    return stepsDuration(steps) / 60;
  };
  const toKm = (min: number) => (easyPace ? (min * 60) / easyPace : null);
  const week0 = weekStart(baseline.asOf);
  const recent = byDistance
    ? [4, 3, 2, 1].map((k) => {
        const s = addDaysIso(week0, -7 * k);
        const e = addDaysIso(s, 6);
        return Math.round(hist.filter((r) => r.date >= s && r.date <= e).reduce((a, r) => a + runSize(r), 0));
      })
    : baseline.recentWeeks?.length === 4
      ? [...baseline.recentWeeks]
      : [1, 2, 3, 4].map(() => baseline.weeklyMinutes);
  const chronic0 = recent.reduce((a, b) => a + b, 0) / 4;
  const best0 = Math.max(...recent);

  // session lengths start from your own runs: the long run from your longest recent runs, easy runs from your usual run
  const from42 = addDaysIso(baseline.asOf, -41);
  const longest6 = hist.filter((r) => r.date >= from42).sort((a, b) => runSize(b) - runSize(a));
  const lastLongest = Math.max(0, ...hist.filter((r) => r.date >= addDaysIso(baseline.asOf, -13)).map(runSize));
  const usualRun = hist.length ? median(hist.map(runSize)) : (baseline.habitualRunMinutes ?? 30);
  const easy0 = Math.round(Math.max(20, Math.min(60, usualRun)));
  const longSeen = longest6.length >= 2 ? (runSize(longest6[0]) + runSize(longest6[1])) / 2 : longest6.length ? runSize(longest6[0]) : baseline.longestRunMinutes * 0.9;
  const long0 = Math.max(longSeen, lastLongest, easy0 * 1.25, 30);
  // how far the long run builds, by goal: minutes, and for races also a multiple of the race distance
  const longCapMin = LONG_CAP[dk ?? goal.kind] ?? 90;
  let longPeak = longCapMin;
  if (dk && dist && easyPace) longPeak = Math.min(longPeak, Math.max(45, (LONG_KM_FACTOR[dk] * (dist / 1000) * easyPace) / 60));
  if (goal.kind === "maintain") longPeak = Math.min(longCapMin, long0);
  longPeak = Math.round(Math.max(longPeak, Math.min(long0, longCapMin)));
  const easyPeak = goal.kind === "maintain" ? easy0 : Math.round(Math.max(easy0, Math.min(60, longPeak * EASY_OF_LONG)));
  // shortest runs: about 70 % of your usual run (20–30 min), lower when a fixed frequency spreads a small week thin
  const minEasyBase = Math.round(Math.max(20, Math.min(30, easy0 * 0.7)));

  // --- weekly ceiling -------------------------------------------------------------
  // The first week may reach the larger of 1.3× your 4-week average (+10 min) and 120 % of your best recent week
  // (110 % with patchy training); then at most one step (10 %, 10–30 min) a week, half after a recovery week.
  const firstCap = Math.max(40, chronic0 * ACWR_MAX + 10, best0 * (lowConsistency ? 1.1 : 1.2));
  let peak = PEAK_MINUTES[dk ?? goal.kind] ?? 300;
  if (goal.kind === "volume" && goal.targetWeeklyKm) peak = Math.round((goal.targetWeeklyKm * (easyPace ?? 390)) / 60);
  if (goal.kind === "maintain") peak = Math.max(chronic0, 45);
  if (config.maxWeeklyMinutes) {
    if (chronic0 > config.maxWeeklyMinutes) warnings.push(`You have averaged ${Math.round(chronic0)} min a week lately, more than your limit of ${config.maxWeeklyMinutes} min. The plan stays at your limit.`);
    peak = Math.min(peak, config.maxWeeklyMinutes);
  }
  peak = Math.max(peak, 45);
  if (fixedRuns != null && Math.min(firstCap, peak) / fixedRuns < 20)
    warnings.push(`Weekly time starts from what you have run lately (about ${Math.round(Math.min(firstCap, peak))} min), so ${fixedRuns} runs a week means short runs at first (about ${Math.round(Math.min(firstCap, peak) / fixedRuns)} min). They get longer as the weekly time builds.`);

  // --- shape: the long run and easy runs build to their peak by the end of the build phase, then hold ----------
  const loading = (p: Phase) => p === "base" || p === "build" || p === "specific";
  let peakIdx = phases.lastIndexOf("build");
  if (peakIdx < 0) peakIdx = phases.indexOf("specific");
  if (peakIdx < 0) peakIdx = Math.max(0, phases.map(loading).lastIndexOf(true));
  const loadCount = (i: number) => phases.slice(0, i + 1).filter(loading).length;
  const K = Math.max(1, loadCount(peakIdx));
  const frac = (i: number) => Math.min(1, loadCount(i) / K);
  const peakWeekStart = addDaysIso(start, peakIdx * 7);
  const taperIdx = phases.map((p, i) => (p === "taper" || p === "race" ? i : -1)).filter((i) => i >= 0);
  const taperFactors = goal.raceDate ? (TAPER_FACTORS[taperIdx.length] ?? []) : [0.7];
  const taperLong = TAPER_LONG[taperIdx.length] ?? [0.65];

  const raceLabel = raceLabelFor(goal);
  const longCtx: LongCtx = { baseline, hist: longest6.slice(0, 2), byDistance, toKm, longPeak, peakWeekStart, dk, dist };

  // planned weeks, built twice: once to project the race time, then with the race pace that projection gives
  const buildWeeks = (ctx: TargetContext, paceNote: string | null) => {
    const workouts: PlannedWorkout[] = [];
    const weekRows: PlanWeek[] = [];
    const runHist = [...runHist0];
    const freqCap = () => {
      const m = runHist.slice(-4).reduce((a, b) => a + b, 0) / 4;
      return Math.min(avail.length, Math.max(2, Math.floor(m * ACWR_MAX + 0.5), m < 4 ? Math.round(m) + 1 : 0));
    };
    const phaseStart = (i: number) => {
      let s = i;
      while (s > 0 && (phases[s - 1] === phases[i] || phases[s - 1] === "recovery")) s--;
      return s;
    };
    const phaseLen = (i: number) => {
      let e = i;
      while (e + 1 < n && (phases[e + 1] === phases[i] || phases[e + 1] === "recovery")) e++;
      return e - phaseStart(i) + 1;
    };
    // single-session spike limit: no run more than 10 % bigger than the biggest in the 30 days before it. A week's
    // limit uses runs (real and planned) from the 24 days before it starts, which lie in every one of its days' windows.
    const sessions: { date: string; size: number }[] = hist.map((r) => ({ date: r.date, size: runSize(r) }));
    const ref30 = baseline.longestRun30Minutes ?? baseline.longestRunMinutes;
    const spikeCap = (ws: string) => {
      const from = addDaysIso(ws, -24);
      const prior = sessions.filter((x) => x.date >= from && x.date < ws).map((x) => x.size);
      const legacy = hist.length === 0 && from <= baseline.asOf ? ref30 : 0;
      return Math.max(SPIKE_FLOOR_MIN, Math.floor(SPIKE_MAX * Math.max(legacy, ...prior)));
    };
    let lastRuns = 0;
    let sinceMore = 0;
    let altern = 0;
    let lastLoad: number | null = null;
    let lastActual: number | null = null;
    let peakLoad = 0;
    let lastLong = long0;
    let peakLong = 0;
    for (let i = 0; i < n; i++) {
      const ws = addDaysIso(start, i * 7);
      const ph = phases[i];
      const progress = phaseLen(i) > 1 ? (i - phaseStart(i)) / (phaseLen(i) - 1) : 0.5;
      const raceDay = ph === "race" && goal.raceDate ? daysBetween(ws, goal.raceDate) : null;
      const inPhase = i - phaseStart(i);

      // session lengths from the shape
      const f = frac(i);
      let L = long0 + (longPeak - long0) * f;
      let E = easy0 + (easyPeak - easy0) * f;
      if (ph === "recovery") {
        L = lastLong * 0.7;
        E *= 0.8;
      } else if (ph === "taper") {
        L = (peakLong || lastLong) * (taperLong[taperIdx.indexOf(i)] ?? 0.65);
        E *= 0.75;
      } else if (ph === "specific" && inPhase % 2 === 1) L *= 0.9; // lighter, faster-finishing long run every other week

      // this week's ceiling
      let cap: number;
      if (ph === "taper" || ph === "race") cap = (peakLoad || Math.min(firstCap, peak)) * (taperFactors[taperIdx.indexOf(i)] ?? 0.6);
      else if (ph === "recovery") cap = (lastActual ?? Math.min(firstCap, peak)) * 0.75;
      else {
        cap = Math.min(peak, lastLoad == null ? firstCap : lastLoad + weeklyStep(lastLoad, lowConsistency) * (phases[i - 1] === "recovery" ? 0.5 : 1));
        // and planned running never grows more than 15 % (or 15 min, or one added easy run) over the last loading week
        if (lastActual != null) cap = Math.min(cap, Math.max(lastActual * 1.15, lastActual + 15, lastActual + 0.85 * E));
      }

      // runs this week (auto): as many as fit under the ceiling at about your easy-run length, starting at most one
      // above your habit, then adding at most one run every 3 loading weeks (a new frequency is held before the next
      // step, as with any load increase), up to 5 a week (6 for the half and marathon) unless you already run more
      const habit = Math.round(runHist.slice(-4).reduce((a, b) => a + b, 0) / 4);
      const allowed = lastRuns === 0 ? Math.max(3, habit < 4 ? habit + 1 : habit) : lastRuns + (sinceMore >= 3 ? 1 : 0);
      const goalMax = Math.max(dk === "half" || dk === "marathon" ? 6 : 5, Math.round(runHist0.reduce((a, b) => a + b, 0) / 4));
      // a run is only added when the week has room for it at a proper length (hard sessions count as 1.25 easy runs)
      const hardFor = (k: number) => (chronic0 < 90 && i < 2 ? 0 : Math.min(ph === "base" ? 1 : 2, k >= 4 ? 2 : k === 3 ? 1 : 0));
      const fits = (k: number) => L + hardFor(k) * 1.25 * E + (k - 1 - hardFor(k)) * 0.85 * E <= cap * 1.05;
      let runsW = Math.max(2, Math.min(allowed, goalMax, freqCap()));
      while (runsW > 2 && !fits(runsW)) runsW--;
      if (ph === "recovery") runsW = Math.max(2, Math.min(runsW, lastRuns || runsW) - 1);
      if (ph === "taper" || ph === "race") runsW = Math.min(avail.length, Math.max(runsW, lastRuns));
      else if (ph !== "recovery") {
        sinceMore = runsW > lastRuns && lastRuns > 0 ? 1 : sinceMore + 1;
        lastRuns = runsW;
      }
      if (fixedRuns != null) runsW = fixedRuns;
      const sCap = spikeCap(ws);
      const minEasy = fixedRuns != null ? Math.max(10, Math.min(minEasyBase, Math.floor(cap / runsW) - 3)) : minEasyBase;
      const minLong = minEasy + 5;
      const days = spreadDays(avail, runsW, longDay);
      const wLong = longDay != null && days.includes(longDay) ? longDay : null;

      const list: { dow: number; spec: Parameters<typeof buildWorkout>[0]; why: string; key: boolean }[] = [];
      const size = (l: (typeof list)[number]) => stepsSize(buildWorkout(l.spec, ctx).steps);
      const mins = (l: (typeof list)[number]) => stepsDuration(buildWorkout(l.spec, ctx).steps) / 60;

      // long run
      let longItem: (typeof list)[number] | null = null;
      if (wLong != null && ph !== "race") {
        const withRacePace = ph === "specific" && (dk === "half" || dk === "marathon") && inPhase % 2 === 0;
        const progressive = !withRacePace && ((ph === "build" && i % 2 === 1) || (ph === "specific" && inPhase % 2 === 1));
        longItem = {
          dow: wLong,
          spec: { type: progressive ? "progressive_long" : "long", minutes: Math.round(Math.max(minLong, Math.min(L, sCap))), withRacePace, goalKey: dk, progress },
          why: "",
          key: ph !== "recovery",
        };
        list.push(longItem);
      }

      // quality: hard sessions allowed by frequency, phase and how much you run now
      const lowBase = chronic0 < 90;
      let hardAllowed = runsW >= 4 ? 2 : runsW === 3 ? 1 : 0;
      if (ph === "base") hardAllowed = Math.min(hardAllowed, 1);
      if (lowBase && i < 2) hardAllowed = 0;
      const types = qualityTypes(goal, dk, ph, config, altern);
      let hardList = types.filter((t) => isHard(t));
      // one hard session a week: alternate the phase's two session types instead of repeating the first
      if (hardAllowed === 1 && hardList.length > 1 && altern % 2 === 1) hardList = [hardList[1], hardList[0], ...hardList.slice(2)];
      altern++;
      const hardTypes = hardList.slice(0, hardAllowed);
      const spare = days.length - (wLong != null ? 1 : 0) - hardTypes.length;
      const extras = types.filter((t) => !isHard(t)).slice(0, Math.max(0, spare - 1));
      let q = [...hardTypes, ...extras];
      let qDays = ph === "race" ? [] : pickQualityDays(days, wLong, q.length);
      if (qDays.length < q.length) q = q.slice(0, qDays.length);
      // 80/20: shrink, then drop, hard sessions until the hard share fits
      let prog = q.map(() => progress);
      const compact = cap < 150;
      const hardShare = () => q.reduce((a, t, k) => a + (isHard(t) ? hardMinutes(buildWorkout({ type: t, progress: prog[k], goalKey: dk, compact }, ctx).steps) : 0), 0);
      while (q.some(isHard) && hardShare() > Math.max(12, cap * HARD_SHARE_MAX)) {
        if (prog.some((p) => p > 0)) prog = prog.map((p) => Math.max(0, p - 0.25));
        else {
          const last = q.map(isHard).lastIndexOf(true);
          q = q.filter((_, k) => k !== last);
          prog = prog.filter((_, k) => k !== last);
          qDays = qDays.filter((_, k) => k !== last);
        }
      }
      q.forEach((t, k) => {
        list.push({ dow: qDays[k], spec: { type: t, progress: prog[k], goalKey: dk, strides: t === "strides", compact }, why: whyQuality(t, ph, goal, baseline, paceNote), key: isHard(t) });
      });

      // race week
      if (ph === "race") {
        const rd = raceDay != null && raceDay >= 0 && raceDay <= 6 ? raceDay : (longDay ?? days[days.length - 1]);
        const isTimeTrial = !goal.raceDate;
        list.push({
          dow: rd,
          spec: { type: "race", distanceM: dist, goalKey: dk },
          why: isTimeTrial
            ? `A time trial to measure where you are: run ${dist ? (dist / 1000).toFixed(1) + " km" : "it"} as fast as you can hold evenly. The result recalibrates your fitness estimate.`
            : `Race day.${ctx.racePace ? ` Plan for about ${formatPace(ctx.racePace)}/km and hold back in the first kilometre.` : ""}`,
          key: true,
        });
        const primer = avail.filter((d) => d < rd && rd - d >= 2 && rd - d <= 4).pop();
        if (primer != null) list.push({ dow: primer, spec: { type: "easy", minutes: 25, strides: true }, why: "A short run with strides keeps your legs sharp without tiring them before the race.", key: false });
        const opener = avail.filter((d) => primer != null && d < primer - 1).pop();
        if (opener != null) list.push({ dow: opener, spec: { type: "easy", minutes: 30 }, why: "Easy running to stay loose in race week.", key: false });
        for (const d of [...avail].reverse()) {
          if (list.length >= runsW) break;
          if (d >= rd - 1 || list.some((l) => l.dow === d)) continue;
          list.push({ dow: d, spec: { type: "easy", minutes: 20 }, why: "A short easy run: in a taper you cut volume but keep your usual rhythm of runs.", key: false });
        }
      }

      // easy runs: your usual run, growing slowly, always clearly shorter than the long run
      const used = new Set(list.map((l) => l.dow));
      const flexible = (l: (typeof list)[number]) => l.spec.type === "strides" || ((l.spec.type === "easy" || l.spec.type === "recovery") && ph !== "race");
      const easyMax = () => Math.max(minEasy, Math.min(60, sCap, longItem ? Math.round((longItem.spec.minutes ?? 0) * 0.8) : 60));
      const each = Math.round(Math.max(minEasy, Math.min(easyMax(), E)));
      for (const l of list) if (flexible(l)) l.spec.minutes = each;
      for (const d of ph === "race" ? [] : days.filter((x) => !used.has(x))) {
        const afterHard = list.some((l) => isHard(l.spec.type) && (l.dow === d - 1 || (d === 0 && l.dow === 6)));
        list.push({
          dow: d,
          spec: { type: afterHard ? "recovery" : "easy", minutes: afterHard ? Math.max(minEasy, Math.min(each, 35)) : each, strides: false },
          why: afterHard ? "The day after a hard session: keep it short and very easy so you absorb the work." : "",
          key: false,
        });
      }

      // fit the week under its ceiling: shorten easy runs, then the long run, then ease and drop hard sessions
      const total = () => list.reduce((a, l) => a + size(l), 0);
      for (let guard = 0; guard < 200 && ph !== "race"; guard++) {
        if (total() <= cap * 1.05) break;
        const easy = list.filter((l) => flexible(l) && (l.spec.minutes ?? 0) > minEasy).sort((a, b) => (b.spec.minutes ?? 0) - (a.spec.minutes ?? 0))[0];
        const long = longItem && (longItem.spec.minutes ?? 0) > minLong ? longItem : null;
        const hard = list.filter((l) => isHard(l.spec.type) && l.spec.type !== "race");
        if (easy) easy.spec.minutes = Math.max(minEasy, (easy.spec.minutes ?? minEasy) - 2);
        else if (long) long.spec.minutes = Math.max(minLong, (long.spec.minutes ?? minLong) - 2);
        else if (hard.some((h) => (h.spec.progress ?? 0) > 0)) for (const h of hard) h.spec.progress = Math.max(0, (h.spec.progress ?? 0) - 0.25);
        else if (hard.length) {
          const h = hard[hard.length - 1];
          h.spec = { type: "easy", minutes: minEasy + 5, strides: config.includeStrides };
          h.key = false;
          h.why = "An easy run with strides instead of a hard session, to keep this week's total within a safe step from the last.";
        } else break;
      }
      // and don't drop below what you already run: lengthen easy runs (up to 80 % of the long run) to your recent average
      const floor = Math.min(cap, chronic0);
      for (let guard = 0; guard < 200 && loading(ph) && total() < floor; guard++) {
        const easy = list.filter((l) => flexible(l) && (l.spec.minutes ?? 0) < easyMax()).sort((a, b) => (a.spec.minutes ?? 0) - (b.spec.minutes ?? 0))[0];
        if (!easy) break;
        easy.spec.minutes = (easy.spec.minutes ?? 0) + 1;
      }

      // single-session spike limit
      for (const l of list) {
        if (l.spec.type === "race") continue;
        while (isHard(l.spec.type) && size(l) > sCap && (l.spec.progress ?? 0) > 0) l.spec.progress = Math.max(0, (l.spec.progress ?? 0) - 0.25);
        if (isHard(l.spec.type) && size(l) > sCap) {
          l.spec = { type: "easy", minutes: Math.floor(sCap), strides: config.includeStrides };
          l.key = false;
          l.why = `An easy run instead of a hard session: with warm-up and cool-down it would be more than 10 % bigger than your biggest run in the last 30 days.`;
        }
        if (l.spec.minutes) for (let g = 0; g < 120 && size(l) > sCap && l.spec.minutes > 20; g++) l.spec.minutes -= 1;
      }
      for (const l of list) if (l.spec.type === "easy" && !l.why) l.why = whyEasy(l.spec.minutes ?? 0, longItem?.spec.minutes ?? 0, baseline, toKm);
      if (longItem) longItem.why = whyLong(longItem.spec.minutes ?? 0, ph, i === 0, longItem.spec.withRacePace ?? false, longItem.spec.type === "progressive_long", longCtx);
      const weekSize = total();
      for (const l of list) if (l.spec.type !== "race" && addDaysIso(ws, l.dow) >= config.startDate) sessions.push({ date: addDaysIso(ws, l.dow), size: size(l) });
      if (loading(ph)) {
        // the ceiling keeps rising by a step a week even when the sessions don't fill it (they follow their own shape)
        lastLoad = Math.max(weekSize, cap);
        lastActual = weekSize;
        peakLoad = Math.max(peakLoad, weekSize);
        if (longItem) {
          lastLong = longItem.spec.minutes ?? lastLong;
          peakLong = Math.max(peakLong, lastLong);
        }
      }

      for (const l of list.sort((a, b) => a.dow - b.dow)) {
        const date = addDaysIso(ws, l.dow);
        if (date < config.startDate) continue;
        if (goal.raceDate && date > goal.raceDate) continue;
        workouts.push(finalize(buildWorkout(l.spec, ctx), date, l.why, l.key));
      }
      void mins;
      weekRows.push({ index: i, start: ws, phase: ph, targetMinutes: Math.round(cap), note: weekNote(ph, i, n, list.length) });
      runHist.push(list.filter((l) => addDaysIso(ws, l.dow) >= config.startDate).length || runsW);
    }
    // planned minutes per week (structured sessions don't divide exactly)
    for (const w of weekRows) {
      const end = addDaysIso(w.start, 6);
      w.targetMinutes = Math.round(workouts.filter((x) => x.date >= w.start && x.date <= end).reduce((a, x) => a + x.durationS / 60, 0));
    }
    return { workouts, weekRows };
  };

  // --- pace and projection --------------------------------------------------
  const goalPace = dist && goal.targetTimeS ? goal.targetTimeS / (dist / 1000) : null;
  const draft = buildWeeks({ baseline, racePace: goalPace ?? (dist ? predictedPace(baseline, dist) : null), raceLabel }, null);
  const trainingWeeks = phases.filter((p) => p !== "taper" && p !== "race").length;
  const trainingRows = draft.weekRows.filter((w) => w.phase !== "taper" && w.phase !== "race");
  const avgPlan = trainingRows.reduce((a, w) => a + w.targetMinutes, 0) / Math.max(1, trainingRows.length);
  const recentMin = baseline.recentWeeks?.length === 4 ? baseline.recentWeeks.reduce((a, b) => a + b, 0) / 4 : baseline.weeklyMinutes;
  const longM = (w: PlannedWorkout) => w.distanceM ?? (w.durationS * 1000) / (easyPace ?? 390);
  const draftLongs = draft.workouts.filter((w) => w.type === "long" || w.type === "progressive_long");
  const projection =
    baseline.vdot != null
      ? project({
          vdot: baseline.vdot,
          distanceM: dist ?? 10_000,
          label: raceLabel ?? "10 km",
          trainingWeeks,
          volumeFactor: volumeFactor(avgPlan, recentMin),
          longestPlannedM: draftLongs.length ? Math.max(...draftLongs.map(longM)) : (baseline.longestRunMinutes * 60 * 1000) / (easyPace ?? 390),
          currentLongestM: longest6.length && longest6[0].km ? longest6[0].km * 1000 : (baseline.longestRunMinutes * 60 * 1000) / (easyPace ?? 390),
          asOf: baseline.asOf,
        })
      : null;
  const pace = choosePace(goal, baseline, projection);
  if (pace.warning) warnings.push(pace.warning);
  const { workouts, weekRows } = buildWeeks({ baseline, racePace: pace.racePace, raceLabel }, pace.note);

  return {
    version: PLANNER_VERSION,
    goal,
    config: { ...config, runDays: avail, longRunDay: longDay, phases: undefined },
    baseline,
    weeks: weekRows,
    workouts,
    summary: summarize(goal, baseline, weekRows, workouts, pace, projection, longCtx),
    warnings,
    racePace: pace.racePace,
    projection,
  };
}

/** Quality days spread as far as possible from the long run and from each other (circular week). */
export function pickQualityDays(days: number[], longDay: number | null, want: number): number[] {
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  const cands = days.filter((d) => d !== longDay);
  let best: number[] = [];
  let bestScore = -Infinity;
  const combos = (k: number, from = 0, acc: number[] = []): number[][] => (acc.length === k ? [acc] : cands.slice(from).flatMap((d, i) => combos(k, from + i + 1, [...acc, d])));
  for (let k = Math.min(want, cands.length); k >= 1; k--) {
    for (const c of combos(k)) {
      const pts = longDay != null ? [...c, longDay] : c;
      let minGap = 7;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minGap = Math.min(minGap, gap(pts[i], pts[j]));
      if (minGap < 2) continue;
      // prefer mid-week sessions (Tue/Thu) when tied
      const score = minGap * 10 - c.reduce((a, d) => a + Math.abs(d - 2.5), 0) * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best.length) break;
  }
  return best.sort((a, b) => a - b);
}

function qualityTypes(goal: Goal, dk: string | null, ph: Phase, c: PlanConfig, alt: number): WorkoutType[] {
  const iv = c.includeIntervals;
  const flip = alt % 2 === 1;
  const st: WorkoutType[] = c.includeStrides ? ["strides"] : [];
  if (ph === "recovery") return st;
  if (ph === "taper") return ["race_pace", ...st];
  if (ph === "race") return [];
  switch (goal.kind) {
    case "consistency":
      return st;
    case "maintain":
      return ["threshold", ...st];
    case "endurance":
      return [ph === "base" ? "tempo" : "threshold", ...st];
    case "volume":
      return [flip ? "tempo" : "threshold", ...st];
    default:
      break;
  }
  if (ph === "base") return [iv ? (flip ? "hills" : "tempo") : "tempo", ...st];
  const speedy = dk === "5k" || dk === "10k" || goal.kind === "general";
  if (ph === "build") {
    // with one hard session a week the generator alternates these two
    if (speedy) return iv ? ["vo2max", "threshold"] : ["threshold", "tempo"];
    return ["threshold", flip ? "tempo" : iv ? "vo2max" : "tempo"];
  }
  // specific
  if (dk == null) return iv ? ["vo2max", "threshold"] : ["threshold", "tempo"];
  if (speedy) return ["race_pace", iv ? (flip ? "repetitions" : "threshold") : "threshold"];
  return ["race_pace", "threshold"];
}

function vdotNote(b: Baseline): string {
  if (b.vdot == null) return "Targets are heart-rate based until there is a fitness estimate.";
  return `Paces come from your current fitness estimate (VDOT ${b.vdot.toFixed(1)}, ${b.vdotConfidence ?? "low"} confidence) and update when it changes.`;
}

function whyQuality(t: WorkoutType, ph: Phase, goal: Goal, b: Baseline, paceNote: string | null): string {
  const g = goal.kind === "race" && goal.name ? goal.name : GOAL_LABEL[goal.kind].toLowerCase();
  const base: Record<string, string> = {
    threshold: `Threshold work raises the pace you can hold for about an hour, the single most useful quality for ${g}.`,
    tempo: "A sustained, comfortably hard run that teaches you to hold a strong pace without going into the red.",
    vo2max: "Intervals near your maximal aerobic pace raise your aerobic ceiling, which lifts every other pace.",
    repetitions: "Short fast reps with full recovery improve speed and running economy without much fatigue.",
    hills: "Hill repeats build strength and power with less pounding than fast flat running; a good start before faster work.",
    race_pace: `Running at goal pace makes it feel familiar and tells you whether the target is right. ${paceNote ?? ""}`.trim(),
    strides: "Strides keep your legs quick on easy days at almost no cost in fatigue.",
  };
  const phaseWhy: Partial<Record<Phase, string>> = {
    base: "Base phase: building volume with light quality.",
    build: "Build phase: the main fitness gains.",
    specific: "Race-specific phase: sessions get closer to race demands.",
    taper: "Taper: less volume, some intensity, so you arrive fresh.",
  };
  return [base[t] ?? "", phaseWhy[ph] ?? "", t === "strides" ? "" : vdotNote(b)].filter(Boolean).join(" ");
}

interface LongCtx {
  baseline: Baseline;
  /** your two longest runs of the last 6 weeks */
  hist: { date: string; minutes: number; km: number | null }[];
  byDistance: boolean;
  toKm: (min: number) => number | null;
  longPeak: number;
  peakWeekStart: string;
  dk: "5k" | "10k" | "half" | "marathon" | null;
  dist: number | null;
}

const kmText = (km: number | null) => (km == null ? "" : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);
const aboutKm = (min: number, toKm: (m: number) => number | null) => {
  const km = toKm(min);
  return km != null ? ` (about ${kmText(km)} at easy pace)` : "";
};

/** Why the long run is this long: where it started from, where it is going, and why that far for this race. */
function whyLong(min: number, ph: Phase, first: boolean, racePace: boolean, prog: boolean, c: LongCtx): string {
  const parts: string[] = [];
  if (first && c.hist.length) {
    const runs = c.hist.map((r) => (r.km != null ? kmText(r.km) : `${r.minutes} min`)).join(" and ");
    parts.push(`Your longest runs lately were ${runs}, so the long run starts there: ${min} min${aboutKm(min, c.toKm)}.`);
  } else parts.push(`The long run builds endurance: ${min} min${aboutKm(min, c.toKm)}.`);
  if (ph === "recovery") parts.push("Shorter this week to recover.");
  else if (ph === "taper") parts.push("Shortened for the taper, so you arrive fresh.");
  else {
    const peakKm = c.toKm(c.longPeak);
    parts.push(`It builds to about ${c.longPeak} min${peakKm != null ? ` (${kmText(peakKm)})` : ""} by the week of ${c.peakWeekStart}, then holds while race-specific sessions take over.`);
  }
  if (c.dk && c.dist && ph !== "recovery" && ph !== "taper") parts.push(LONG_REASON[c.dk]);
  if (racePace) parts.push("Goal-pace segments late in the run rehearse race day on tired legs.");
  if (prog) parts.push("Finish the last quarter a little faster to practise running strong when tired.");
  return parts.join(" ");
}

const LONG_REASON: Record<"5k" | "10k" | "half" | "marathon", string> = {
  "5k": "A 5 km is mostly aerobic, so long runs well past race distance (up to about 12 km) build the engine; more than that adds fatigue without helping a 5 km.",
  "10k": "A 10 km is about 90 % aerobic, so long runs a bit past race distance (up to about 1.3×) build the endurance to hold your pace through the last kilometres. Longer than that mostly adds fatigue for this distance.",
  half: "For the half, the long run approaches race distance so the distance itself holds no surprises on race day.",
  marathon: "For the marathon, the long run stops around 32 km or 2.5 hours: beyond that, recovery costs more than the run gives.",
};

function whyEasy(min: number, longMin: number, b: Baseline, toKm: (m: number) => number | null): string {
  const hr = b.hrZones ? `, heart rate under ${b.hrZones[1].maxBpm}` : "";
  const vsLong = longMin > 0 ? ` It stays well short of the long run (${longMin} min), so that one does the endurance work and this one is easy to recover from.` : "";
  return `Easy running builds the aerobic base everything else rests on: ${min} min${aboutKm(min, toKm)}, conversational${hr}.${vsLong}`;
}

function weekNote(ph: Phase, i: number, n: number, runs: number): string {
  const r = `${runs} run${runs === 1 ? "" : "s"}`;
  switch (ph) {
    case "recovery":
      return `Lighter week to absorb the training: ${r}.`;
    case "taper":
      return `Taper: less running, keep some intensity. ${r}.`;
    case "race":
      return "Race week.";
    default:
      return i === 0 ? `First week: close to what you run now. ${r}.` : i === n - 1 ? `Last week. ${r}.` : `${r}.`;
  }
}

function summarize(goal: Goal, b: Baseline, weeks: PlanWeek[], workouts: PlannedWorkout[], pace: Pace, proj: Projection | null, c: LongCtx): string[] {
  const out: string[] = [];
  const counts = new Map<Phase, number>();
  for (const w of weeks) counts.set(w.phase, (counts.get(w.phase) ?? 0) + 1);
  const order: Phase[] = ["base", "build", "specific", "recovery", "taper", "race"];
  const label: Record<Phase, string> = { base: "base", build: "build", specific: "race-specific", recovery: "recovery", taper: "taper", race: "race" };
  out.push(`${weeks.length} weeks: ${order.filter((p) => counts.get(p)).map((p) => `${counts.get(p)} ${label[p]}`).join(", ")}.`);
  const peak = weeks.reduce((a, w) => (w.targetMinutes > a.targetMinutes ? w : a), weeks[0]);
  if (peak) out.push(`Weekly running goes from ${hm(weeks[0].targetMinutes)} to a peak of ${hm(peak.targetMinutes)} in week ${peak.index + 1}; you have averaged ${hm(b.weeklyMinutes)} over the last 4 weeks.`);
  const longs = workouts.filter((w) => w.type === "long" || w.type === "progressive_long");
  if (longs.length) {
    const km = (w: PlannedWorkout) => (w.distanceM ? ` (${kmText(w.distanceM / 1000)})` : "");
    const top = longs.reduce((a, w) => (w.durationS > a.durationS ? w : a), longs[0]);
    out.push(`Long run: starts at ${Math.round(longs[0].durationS / 60)} min${km(longs[0])} from your recent long runs and builds to ${Math.round(top.durationS / 60)} min${km(top)}, then holds until the taper.${c.dk ? ` ${LONG_REASON[c.dk]}` : ""}`);
  }
  const d = goalDistance(goal);
  if (d) {
    const pred = predictedPace(b, d);
    const bits: string[] = [];
    if (pred) bits.push(`predicted now ${fmtTime((pred * d) / 1000)}`);
    if (goal.targetTimeS) bits.push(`target ${fmtTime(goal.targetTimeS)}`);
    if (bits.length) out.push(`${goal.name ?? GOAL_LABEL[goal.kind]}: ${bits.join(", ")}.`);
  }
  if (proj) out.push(`If you follow it: ${proj.label} ${fmtTime(proj.nowS)} now → about ${fmtTime(proj.projectedS)} (range ${fmtTime(proj.slowS)}–${fmtTime(proj.fastS)}). This projection is a heuristic based on typical gains; it is updated from your actual fitness as you train.`);
  out.push(`Load limits: no run more than 10 % bigger than your biggest in the previous 30 days, at most +10 % (or +10–30 min) a week, a lighter week every ${b.consistency < 0.6 ? 3 : 4} weeks, and at most ${Math.round(HARD_SHARE_MAX * 100)} % of running time at threshold or harder.`);
  if (pace.note) out.push(pace.note);
  return out;
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min` : `${Math.round(min)} min`);
