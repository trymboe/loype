/**
 * Deterministic plan generator (`planner@3`). Pure: goal + availability +
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
  type IntensityPref,
  type Phase,
  type PlanConfig,
  type PlanWeek,
  type PlannedWorkout,
  type Step,
  type VolumePref,
  type WorkoutType,
} from "./types";
import { buildWorkout, finalize, stepsDistance, stepsDuration, type TargetContext } from "./workouts";
import { project, volumeFactor, type Projection } from "./projection";

export const MIN_WEEKS = 2;
export const MAX_WEEKS = 24;

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

function assignPhases(goal: Goal, n: number, every: number): Phase[] {
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
  // recovery weeks: every 3rd or 4th week (by volume; every 3rd with patchy recent training), never right before the taper
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

/** Acute:chronic workload ratio ceiling (week vs the 4 weeks before it), used for the first week. */
export const ACWR_MAX = 1.3;
/** Share of weekly time at threshold or harder (the "80/20" rule, with some room for warm-ups). */
export const HARD_SHARE_MAX = 0.2;

/** Taper long runs as a share of the longest long run, one per taper week before race week. */
const TAPER_LONG: Record<number, number[]> = { 1: [], 2: [0.65], 3: [0.75, 0.6] };

/**
 * Training volume, as in Runna's "Gradual / Steady / Progressive": how fast the week grows, how often a lighter week
 * comes, and how long the long run and the easy runs get at their peak. The week then *holds* at that peak; it never
 * keeps growing just because there are weeks left.
 */
export const VOLUME_PREFS: Record<VolumePref, { rate: number; deloadEvery: number; deload: number; idx: 0 | 1 | 2 }> = {
  gradual: { rate: 0.07, deloadEvery: 3, deload: 0.7, idx: 0 },
  steady: { rate: 0.1, deloadEvery: 4, deload: 0.75, idx: 1 },
  progressive: { rate: 0.12, deloadEvery: 4, deload: 0.75, idx: 2 },
};
/**
 * Longest long run in km by race distance and volume (gradual, steady, progressive). 5 and 10 km are ~90 % aerobic, so
 * modest over-distance long runs build the endurance to hold pace to the line (10 km: 1.1–1.4× race distance); for the
 * half and the marathon the long run approaches or stays under race distance (Daniels, Pfitzinger, Runna's plans).
 */
export const LONG_KM: Record<"5k" | "10k" | "half" | "marathon", [number, number, number]> = {
  "5k": [8, 10, 12],
  "10k": [11, 12, 14],
  half: [17, 19, 21],
  marathon: [28, 30, 32],
};
/** …and in minutes, which also caps it for slower runners. Non-race goals use `other`. */
const LONG_MIN: Record<string, [number, number, number]> = { "5k": [60, 70, 80], "10k": [75, 85, 95], half: [120, 135, 150], marathon: [150, 165, 180], other: [60, 75, 90] };
/** Longest easy run, minutes: easy runs stay short and clearly below the long run. */
const EASY_MAX: Record<string, [number, number, number]> = { "5k": [35, 40, 50], "10k": [35, 40, 50], half: [40, 45, 55], marathon: [45, 55, 65], other: [35, 40, 50] };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Hard sessions a week, by runs per week, phase and the intensity you chose (Runna's Comfortable / Balanced / Challenging). */
export function hardSessions(runs: number, ph: Phase, intensity: IntensityPref): number {
  if (ph === "recovery" || ph === "race") return 0;
  if (ph === "taper") return runs >= 3 ? 1 : 0;
  if (ph === "base") return intensity === "comfortable" ? 0 : runs >= 3 ? 1 : 0;
  if (intensity === "comfortable") return runs >= 3 ? 1 : 0;
  if (intensity === "balanced") return runs >= 4 ? 2 : runs >= 2 ? 1 : 0;
  return runs >= 3 ? 2 : runs === 2 ? 1 : 0;
}
/** How far quality sessions progress, by intensity (1 = the full session at the end of a phase). */
const INTENSITY_PROGRESS: Record<IntensityPref, number> = { comfortable: 0.5, balanced: 0.8, challenging: 1 };

/** Runs a week when you leave it on auto: one more than you run now, at least 3 and at most 4 (more only if you already run more). */
export function autoRuns(habit: number, avail: number): number {
  const h = Math.round(habit);
  return Math.max(1, Math.min(avail, h >= 4 ? Math.min(6, h) : Math.max(3, h + 1)));
}

export function generatePlan(goal: Goal, config: PlanConfig, baseline: Baseline): GeneratedPlan {
  const warnings: string[] = [];
  const { start, weeks: n, warnings: w0 } = planWeeks(goal, config);
  warnings.push(...w0);
  const lowConsistency = baseline.consistency < 0.6;
  const volume: VolumePref = config.volume ?? "steady";
  const intensity: IntensityPref = config.intensity ?? "balanced";
  const pref = VOLUME_PREFS[volume];
  const phases = config.phases && config.phases.length === n ? config.phases : assignPhases(goal, n, lowConsistency ? 3 : pref.deloadEvery);
  const dist = goalDistance(goal);
  const dk = distanceKey(dist);
  if (!baseline.paceZones) warnings.push(baseline.hrZones ? "No fitness estimate yet, so sessions use heart-rate targets only. Paces are added once the estimate is available." : "No fitness estimate or heart-rate zones yet, so sessions are described by effort.");

  // --- days and frequency -------------------------------------------------
  const unavailable = new Set(config.unavailableDays);
  const avail = [...new Set(config.runDays)].filter((d) => d >= 0 && d <= 6 && !unavailable.has(d)).sort((a, b) => a - b);
  if (avail.length === 0) avail.push(1, 3, 5, 6);
  const usual = config.usualRunsPerWeek != null && config.usualRunsPerWeek > 0 ? Math.min(7, config.usualRunsPerWeek) : null;
  const habit = usual ?? (baseline.recentRunCounts?.length === 4 ? baseline.recentRunCounts.reduce((a, b) => a + b, 0) / 4 : baseline.runsPerWeek);
  // a fixed number of runs a week (never more than the days you can run); auto picks one number for the whole plan
  const fixedRuns = config.runsPerWeek != null && config.runsPerWeek >= 1 ? Math.min(avail.length, Math.round(config.runsPerWeek)) : null;
  if (fixedRuns != null && config.runsPerWeek! > avail.length) warnings.push(`You asked for ${config.runsPerWeek} runs a week but ticked ${avail.length} days, so the plan uses ${avail.length}.`);
  const runs = fixedRuns ?? autoRuns(habit, avail.length);
  if (fixedRuns != null && fixedRuns > autoRuns(habit, avail.length))
    warnings.push(`${fixedRuns} runs a week is a big step from the ${Math.round(habit * 10) / 10} you have averaged lately. The plan starts with fewer runs and adds them as your weekly running grows, so no run is too short to be worth doing.`);

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
  // the long-run day: the one you chose, else the day that leaves the best recovery around it (see chooseLongRunDay)
  const fixedLong = config.longRunDay != null && avail.includes(config.longRunDay) ? config.longRunDay : null;
  const habitLong = [...hist].filter((r) => r.date >= addDaysIso(baseline.asOf, -41)).sort((a, b) => runSize(b) - runSize(a))[0];
  const longDay = config.includeLongRuns
    ? (fixedLong ?? chooseLongRunDay(avail, runs, config.includeIntervals ? hardSessions(runs, "build", intensity) : 0, habitLong ? dowOf(habitLong.date) : null))
    : null;
  const toKm = (min: number) => (easyPace ? (min * 60) / easyPace : null);
  const fromKm = (km: number) => (easyPace ? (km * easyPace) / 60 : null);
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

  // --- session targets: where each kind of run starts (from your runs) and where it peaks (from the race and volume) ---
  const key = dk ?? "other";
  const from42 = addDaysIso(baseline.asOf, -41);
  const longest6 = hist.filter((r) => r.date >= from42).sort((a, b) => runSize(b) - runSize(a));
  const usualRun = hist.length ? median(hist.map(runSize)) : (baseline.habitualRunMinutes ?? 30);
  // (never shorter than the easy runs you already do, up to an hour)
  let easyPeak = goal.kind === "maintain" ? Math.max(25, Math.min(60, usualRun)) : Math.max(EASY_MAX[key][pref.idx], Math.min(60, usualRun));
  const easy0 = Math.round(Math.max(20, Math.min(easyPeak, usualRun)));
  const longSeen = longest6.length >= 2 ? (runSize(longest6[0]) + runSize(longest6[1])) / 2 : longest6.length ? runSize(longest6[0]) : baseline.longestRunMinutes * 0.9;
  let longPeak = LONG_MIN[key][pref.idx];
  if (dk) {
    const km = fromKm(LONG_KM[dk][pref.idx]);
    if (km != null) longPeak = Math.min(longPeak, km);
  }
  if (goal.kind === "maintain") longPeak = Math.max(40, Math.min(longPeak, longSeen));
  longPeak = Math.round(longPeak);
  // a weekly-volume goal: easy runs grow so the peak week reaches the volume you asked for
  const targetMin = goal.kind === "volume" && goal.targetWeeklyKm ? fromKm(goal.targetWeeklyKm) : null;
  if (targetMin != null && runs > 1) easyPeak = Math.round(Math.max(25, Math.min(75, (targetMin - longPeak) / (runs - 1))));
  // the long run starts a little under your recent long runs (the week around it is still small), at least clearly longer than an easy run
  const long0 = Math.round(Math.min(longPeak, Math.max(0.8 * longSeen, easy0 * 1.25, 30)));

  // --- weekly ceiling -------------------------------------------------------------
  // Week 1 may reach the larger of 1.3× your 4-week average (+10 min) and your best recent week (90 % of it with
  // patchy training); then a loading week grows at most `rate` (at least 6 min) over the last loading week, half that
  // after a lighter week. A lighter week is 70–75 % of the week before it.
  // (with next to no recorded running, enough for the runs you chose at about 20 min each)
  // (held back after a high-load week: hills and hard running count, not only distance; see running-load.ts)
  const firstCap = Math.max(chronic0 < 30 ? runs * 22 + 10 : 60, chronic0 + (Math.max(chronic0 * ACWR_MAX + 10, best0 * (lowConsistency ? 0.9 : 1)) - chronic0) * (baseline.loadTemper ?? 1));
  const userMax = config.maxWeeklyMinutes ?? Infinity;
  if (config.maxWeeklyMinutes && chronic0 > config.maxWeeklyMinutes) warnings.push(`You have averaged ${Math.round(chronic0)} min a week lately, more than your limit of ${config.maxWeeklyMinutes} min. The plan stays at your limit.`);

  // --- shape: sessions build to their peak by the end of the build phase, then hold ----------
  const loading = (p: Phase) => p === "base" || p === "build" || p === "specific";
  let peakIdx = phases.lastIndexOf("build");
  if (peakIdx < 0) peakIdx = phases.indexOf("specific");
  if (peakIdx < 0) peakIdx = Math.max(0, phases.map(loading).lastIndexOf(true));
  const loadCount = (i: number) => phases.slice(0, i + 1).filter(loading).length;
  // sessions reach their peak within about 10 loading weeks (a long plan then holds there longer instead of creeping up)
  const K = Math.max(1, Math.min(10, loadCount(peakIdx) - 1));
  const frac = (i: number) => Math.min(1, Math.max(0, (loadCount(i) - 1) / K));
  const peakWeekStart = addDaysIso(start, peakIdx * 7);
  const taperIdx = phases.map((p, i) => (p === "taper" || p === "race" ? i : -1)).filter((i) => i >= 0);
  const taperFactors = goal.raceDate ? (TAPER_FACTORS[taperIdx.length] ?? []) : [0.7];
  const taperLong = TAPER_LONG[taperIdx.length] ?? [0.65];

  const raceLabel = raceLabelFor(goal);
  const longCtx: LongCtx = { baseline, hist: longest6.slice(0, 2), byDistance, toKm, longPeak, peakWeekStart, dk, dist, volume };

  // planned weeks, built twice: once to project the race time, then with the race pace that projection gives
  const buildWeeks = (ctx: TargetContext, paceNote: string | null) => {
    const workouts: PlannedWorkout[] = [];
    const weekRows: PlanWeek[] = [];
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
    let altern = 0;
    let lastRuns = 0;
    const rotIdx: Record<Phase, number> = { base: 0, build: 0, specific: 0, taper: 0, recovery: 0, race: 0 };
    let lastActual: number | null = null;
    let afterDeload = false;
    let peakLoad = 0;
    let lastLong = long0;
    let peakLong = 0;
    for (let i = 0; i < n; i++) {
      const ws = addDaysIso(start, i * 7);
      const ph = phases[i];
      const progress = (phaseLen(i) > 1 ? (i - phaseStart(i)) / (phaseLen(i) - 1) : 0.5) * INTENSITY_PROGRESS[intensity];
      const raceDay = ph === "race" && goal.raceDate ? daysBetween(ws, goal.raceDate) : null;
      const inPhase = i - phaseStart(i);

      // this week's ceiling
      let cap: number;
      if (ph === "taper" || ph === "race") cap = (peakLoad || firstCap) * (taperFactors[taperIdx.indexOf(i)] ?? 0.6);
      else if (ph === "recovery") cap = (lastActual ?? firstCap) * pref.deload;
      else if (lastActual == null) cap = firstCap;
      else cap = afterDeload ? Math.max(lastActual * (1 + pref.rate / 2), lastActual + 3) : Math.max(lastActual * (1 + pref.rate), lastActual + 6);
      cap = Math.min(cap, userMax);

      // session lengths from the shape: straight lines from where you are to the peak, held after it
      const f = frac(i);
      let L = long0 + (longPeak - long0) * f;
      let E = easy0 + (easyPeak - easy0) * f;
      if (loading(ph)) L = Math.min(L, Math.max(lastLong * 1.1, lastLong + 5)); // never more than 10 % (or 5 min) over the last long run
      if (ph === "recovery") {
        L = lastLong * pref.deload;
        E *= 0.85;
      } else if (ph === "taper") {
        L = (peakLong || lastLong) * (taperLong[taperIdx.indexOf(i)] ?? 0.65);
        E *= 0.8;
      } else if (ph === "specific" && inPhase % 2 === 1) L *= 0.9; // lighter, faster-finishing long run every other week

      // the long run's share of the week (60 % with 2 runs, 50 % with 3, 40 % with 4, 35 % with 5+; 5–10 points more for the
      // half and the marathon, where the long run is the key session), so it can't eat all the growth
      const longShare = (runs <= 2 ? 0.6 : runs === 3 ? 0.5 : runs === 4 ? 0.4 : 0.35) + (dk === "marathon" ? 0.1 : dk === "half" ? 0.05 : 0);
      if (ph !== "race") L = Math.min(L, cap * longShare);
      const sCap = spikeCap(ws);
      // runs this week: the number you chose, once the week is big enough for each run to be at least ~20 min next to
      // the long run (a run joins as the weekly volume grows, rather than every run being cut short)
      const need = (k: number) => Math.min(L, sCap) * 0.9 + (k - 1) * 20;
      let runsW = runs;
      if (ph !== "race") while (runsW > Math.min(2, runs) && need(runsW) > cap) runsW--;
      // lighter and taper weeks keep the rhythm of runs you have reached (each run is shorter instead)
      if ((ph === "recovery" || ph === "taper") && lastRuns > 0) runsW = Math.min(runs, Math.max(runsW, lastRuns));
      if (loading(ph)) lastRuns = runsW;
      const minEasy = Math.max(12, Math.min(20, Math.floor(cap / runsW) - 3));
      const minLong = Math.min(Math.max(minEasy + 10, L * 0.9), L);
      const days = spreadDays(avail, runsW, longDay);
      const wLong = longDay != null && days.includes(longDay) ? longDay : null;

      const list: { dow: number; spec: Parameters<typeof buildWorkout>[0]; why: string; key: boolean }[] = [];
      const size = (l: (typeof list)[number]) => stepsSize(buildWorkout(l.spec, ctx).steps);

      // long run
      let longItem: (typeof list)[number] | null = null;
      if (wLong != null && ph !== "race") {
        const withRacePace = ph === "specific" && (dk === "half" || dk === "marathon") && inPhase % 2 === 0;
        const progressive = !withRacePace && ((ph === "build" && i % 2 === 1) || (ph === "specific" && inPhase % 2 === 1));
        longItem = {
          dow: wLong,
          spec: { type: progressive ? "progressive_long" : "long", minutes: Math.round(Math.max(minEasy + 5, Math.min(L, sCap))), withRacePace, goalKey: dk, progress },
          why: "",
          key: ph !== "recovery",
        };
        list.push(longItem);
      }

      // baseline time trial (week 1, when chosen): on a quality day at least 2 days from the long run, in place of one hard session
      const ttDay = i === 0 && config.baselineTimeTrial && loading(ph) ? (pickQualityDays(days.filter((d) => addDaysIso(ws, d) >= config.startDate), wLong, 1)[0] ?? null) : null;

      // quality: hard sessions by runs per week, phase and intensity; none in the first two weeks if you run little now
      let hardAllowed = hardSessions(runsW, ph, intensity);
      if (chronic0 < 90 && i < 2) hardAllowed = 0;
      if (ttDay != null) hardAllowed = Math.max(0, hardAllowed - 1);
      const types = qualityTypes(goal, dk, ph, config, altern, intensity);
      // hard sessions rotate through the phase's session types, so each week differs from the last
      const rot = hardRotation(goal, dk, ph, config, intensity) ?? types.filter((t) => isHard(t));
      const hardTypes: WorkoutType[] = [];
      for (let k = 0; hardTypes.length < hardAllowed && k < rot.length; k++) {
        const t = rot[(rotIdx[ph] + k) % rot.length];
        if (!hardTypes.includes(t)) hardTypes.push(t);
      }
      if (hardTypes.length) rotIdx[ph] += hardTypes.length;
      altern++;
      const spare = days.length - (wLong != null ? 1 : 0) - (ttDay != null ? 1 : 0) - hardTypes.length;
      const extras = types.filter((t) => !isHard(t)).slice(0, Math.max(0, Math.min(1, spare - 1)));
      let q = [...hardTypes, ...extras];
      const clearOfTt = ttDay == null ? days : days.filter((d) => Math.min(Math.abs(d - ttDay), 7 - Math.abs(d - ttDay)) >= 2);
      let qDays = ph === "race" ? [] : pickQualityDays(clearOfTt, wLong, q.length);
      if (qDays.length < q.length) q = q.slice(0, qDays.length);
      // 80/20: shrink, then drop, hard sessions until the hard share fits
      let prog = q.map(() => progress);
      // short warm-up and cool-down (10 + 5 min) for 5 and 10 km plans and small weeks; longer for the half and marathon
      const compact = cap < 180 || !(dk === "half" || dk === "marathon");
      // the time trial: 5 km, or 3 km for a 5 km goal or if you run little now; shorter (then with a compact warm-up) to stay
      // within the single-run spike limit
      let ttItem: (typeof list)[number] | null = null;
      if (ttDay != null) {
        const d0 = dk === "5k" || chronic0 < 90 ? 3000 : 5000;
        const options = [...new Set([d0, 3000])].flatMap((d) => [compact, true].map((c) => ({ type: "time_trial" as const, distanceM: d, compact: c })));
        const spec = options.find((o) => stepsSize(buildWorkout(o, ctx).steps) <= sCap) ?? options[options.length - 1];
        ttItem = { dow: ttDay, spec, why: TT_WHY, key: true };
        list.push(ttItem);
      }
      const ttHard = ttItem ? hardMinutes(buildWorkout(ttItem.spec, ctx).steps) : 0;
      const hardShare = () => ttHard + q.reduce((a, t, k) => a + (isHard(t) ? hardMinutes(buildWorkout({ type: t, progress: prog[k], goalKey: dk, compact }, ctx).steps) : 0), 0);
      // (in the taper, volume drops but the intensity stays: up to 30 %)
      while (q.some(isHard) && hardShare() > Math.max(12, cap * (ph === "taper" ? 0.3 : HARD_SHARE_MAX))) {
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
        if (opener != null && list.length < runsW) list.push({ dow: opener, spec: { type: "easy", minutes: 30 }, why: "Easy running to stay loose in race week.", key: false });
      }

      // easy runs: your usual run, growing slowly to the volume's easy-run length, always clearly shorter than the long run
      const used = new Set(list.map((l) => l.dow));
      const flexible = (l: (typeof list)[number]) => l.spec.type === "strides" || ((l.spec.type === "easy" || l.spec.type === "recovery") && ph !== "race");
      const easyMax = () => Math.max(minEasy, Math.min(easyPeak, sCap, longItem ? Math.round((longItem.spec.minutes ?? 0) * 0.75) : easyPeak));
      const each = Math.round(Math.max(minEasy, Math.min(easyMax(), E)));
      for (const l of list) if (flexible(l)) l.spec.minutes = each;
      for (const d of ph === "race" ? [] : days.filter((x) => !used.has(x))) {
        const afterHard = list.some((l) => isHard(l.spec.type) && (l.dow === d - 1 || (d === 0 && l.dow === 6)));
        list.push({
          dow: d,
          spec: { type: afterHard ? "recovery" : "easy", minutes: afterHard ? Math.max(minEasy, Math.min(each, 30)) : each, strides: false },
          why: afterHard ? "The day after a hard session: keep it short and very easy so you absorb the work." : "",
          key: false,
        });
      }

      // fit the week under its ceiling: shorten easy runs, then ease hard sessions, then the long run, then swap a hard session for easy
      const total = () => list.reduce((a, l) => a + size(l), 0);
      for (let guard = 0; guard < 300 && ph !== "race"; guard++) {
        if (total() <= cap * 1.01) break;
        const easy = list.filter((l) => flexible(l) && (l.spec.minutes ?? 0) > minEasy).sort((a, b) => (b.spec.minutes ?? 0) - (a.spec.minutes ?? 0))[0];
        const long = longItem && (longItem.spec.minutes ?? 0) > minLong ? longItem : null;
        const hard = list.filter((l) => isHard(l.spec.type) && l.spec.type !== "race");
        // in a tight week the long run matters more than a squeezed-in hard session
        if (easy) easy.spec.minutes = Math.max(minEasy, (easy.spec.minutes ?? minEasy) - 1);
        else if (hard.some((h) => (h.spec.progress ?? 0) > 0)) for (const h of hard) h.spec.progress = Math.max(0, (h.spec.progress ?? 0) - 0.25);
        else if (hard.some((h) => h.spec.type === "time_trial" && (h.spec.distanceM ?? 0) > 3000)) {
          for (const h of hard) if (h.spec.type === "time_trial") h.spec.distanceM = 3000;
        } else if (hard.length && !(long && hard.every((h) => h.spec.type === "time_trial"))) {
          // (the time trial is listed first, so it is the last to go, and only once the long run is as short as it gets)
          const h = hard[hard.length - 1];
          h.spec = { type: "easy", minutes: minEasy + 5, strides: config.includeStrides };
          h.key = false;
          h.why = "An easy run with strides instead of a hard session: this week is still small, and the long run matters more.";
        } else if (long) long.spec.minutes = Math.max(minLong, (long.spec.minutes ?? minLong) - 1);
        else if (longItem && (longItem.spec.minutes ?? 0) > minEasy + 5) longItem.spec.minutes = (longItem.spec.minutes ?? 0) - 1;
        else break;
      }

      // and a loading week doesn't drop below what you already run: lengthen easy runs (up to their peak length) to your recent average
      const floor = Math.min(cap, chronic0);
      for (let guard = 0; guard < 300 && loading(ph) && total() < floor; guard++) {
        const easy = list.filter((l) => flexible(l) && (l.spec.minutes ?? 0) < Math.max(easyMax(), 60 * Math.min(1, chronic0 / 240))).sort((a, b) => (a.spec.minutes ?? 0) - (b.spec.minutes ?? 0))[0];
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
        lastActual = weekSize;
        afterDeload = false;
        peakLoad = Math.max(peakLoad, weekSize);
        if (longItem) {
          lastLong = longItem.spec.minutes ?? lastLong;
          peakLong = Math.max(peakLong, lastLong);
        }
      } else if (ph === "recovery") afterDeload = true;

      for (const l of list.sort((a, b) => a.dow - b.dow)) {
        const date = addDaysIso(ws, l.dow);
        if (date < config.startDate) continue;
        if (goal.raceDate && date > goal.raceDate) continue;
        workouts.push(finalize(buildWorkout(l.spec, ctx), date, l.why, l.key));
      }
      weekRows.push({ index: i, start: ws, phase: ph, targetMinutes: Math.round(cap), note: "" });
    }
    // planned minutes and distance per week (structured sessions don't divide exactly)
    for (const w of weekRows) {
      const end = addDaysIso(w.start, 6);
      const ws = workouts.filter((x) => x.date >= w.start && x.date <= end);
      w.targetMinutes = Math.round(ws.reduce((a, x) => a + x.durationS / 60, 0));
      const km = ws.every((x) => x.distanceM != null) ? ws.reduce((a, x) => a + (x.distanceM ?? 0), 0) / 1000 : null;
      w.note = weekNote(w.phase, w.index, n, ws.length, km, w.index === peakIdx);
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
    // the long-run day stays as you set it: "best fit" (null) is chosen again whenever the plan is recalculated
    config: { ...config, runDays: avail, longRunDay: fixedLong, phases: undefined, volume, intensity },
    baseline,
    weeks: weekRows,
    workouts,
    summary: summarize(goal, baseline, weekRows, workouts, pace, projection, longCtx, { runs, volume, intensity, auto: fixedRuns == null, deloadEvery: lowConsistency ? 3 : pref.deloadEvery, rate: pref.rate }),
    warnings,
    racePace: pace.racePace,
    projection,
  };
}

const TT_WHY = "A baseline time trial: run it as fast as you can hold evenly. The result is your reference for the plan and recalibrates your fitness estimate.";

/** Monday-based day of the week (0 = Mon … 6 = Sun) of an ISO date. */
function dowOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * The long-run day when you leave it to the planner. Every available day is tried with the week it gives (the same
 * `spreadDays` and `pickQualityDays` the plan uses), scored by, in order: fitting all the week's hard sessions at least
 * 2 days from each other and the long run; the runs being spread out; a rest day after the long run (the biggest
 * session of the week, so the day after it is the one that most needs to be free); a run-free or easy day before it
 * (no hard session the day before). Ties go to the day your longest run of the last 6 weeks fell on (you had time
 * for it then), then to the weekend, then to later in the week. One day is used for the whole plan, so the week keeps the same rhythm.
 */
export function chooseLongRunDay(avail: number[], runs: number, hard: number, habitDay: number | null = null): number {
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  let best = avail[avail.length - 1];
  let bestScore = -Infinity;
  for (const d of avail) {
    const days = spreadDays(avail, Math.min(runs, avail.length), d);
    if (!days.includes(d)) continue;
    const q = pickQualityDays(days, d, hard);
    let minGap = 7;
    for (let i = 0; i < days.length; i++) for (let j = i + 1; j < days.length; j++) minGap = Math.min(minGap, gap(days[i], days[j]));
    const restAfter = !days.includes((d + 1) % 7);
    const restBefore = !days.includes((d + 6) % 7);
    const hardBefore = q.includes((d + 6) % 7);
    const score =
      Math.min(q.length, hard) * 1000 + minGap * 100 + (restAfter ? 40 : 0) + (restBefore ? 15 : 0) - (hardBefore ? 30 : 0) + (d === 6 ? 6 : d === 5 ? 5 : d * 0.5) + (habitDay === d ? 8 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
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

/**
 * The order hard sessions come in for a race goal, by phase: base is tempo and hills, build alternates threshold and
 * VO2max, race-specific mixes race pace with threshold and fast repetitions. Comfortable leaves out the fastest work.
 * Null for other goals (they use qualityTypes).
 */
function hardRotation(goal: Goal, dk: string | null, ph: Phase, c: PlanConfig, intensity: IntensityPref): WorkoutType[] | null {
  if (!dk) return null;
  const iv = c.includeIntervals && intensity !== "comfortable";
  const speedy = dk === "5k" || dk === "10k";
  switch (ph) {
    case "base":
      return iv ? ["tempo", "hills"] : ["tempo"];
    case "build":
      return speedy ? (iv ? ["threshold", "vo2max"] : ["threshold", "tempo"]) : iv ? ["threshold", "tempo", "threshold", "vo2max"] : ["threshold", "tempo"];
    case "specific":
      return speedy ? (iv ? ["race_pace", "threshold", "race_pace", "repetitions"] : ["race_pace", "threshold"]) : ["race_pace", "threshold"];
    case "taper":
      return ["race_pace"];
    default:
      return [];
  }
}

function qualityTypes(goal: Goal, dk: string | null, ph: Phase, c: PlanConfig, alt: number, intensity: IntensityPref = "balanced"): WorkoutType[] {
  // Comfortable keeps to threshold-type work: no VO2max intervals or fast repetitions
  const iv = c.includeIntervals && intensity !== "comfortable";
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
  volume: VolumePref;
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
  "5k": "A 5 km is mostly aerobic, so long runs well past race distance build the engine; more than about 10–12 km adds fatigue without helping a 5 km.",
  "10k": "A 10 km is about 90 % aerobic, so long runs a little past race distance build the endurance to hold your pace through the last kilometres. Longer than that mostly adds fatigue for this distance.",
  half: "For the half, the long run approaches race distance so the distance itself holds no surprises on race day.",
  marathon: "For the marathon, the long run stops around 32 km or 2.5 hours: beyond that, recovery costs more than the run gives.",
};

function whyEasy(min: number, longMin: number, b: Baseline, toKm: (m: number) => number | null): string {
  const hr = b.hrZones ? `, heart rate under ${b.hrZones[1].maxBpm}` : "";
  const vsLong = longMin > 0 ? ` It stays well short of the long run (${longMin} min), so that one does the endurance work and this one is easy to recover from.` : "";
  return `Easy running builds the aerobic base everything else rests on: ${min} min${aboutKm(min, toKm)}, conversational${hr}.${vsLong}`;
}

function weekNote(ph: Phase, i: number, n: number, runs: number, km: number | null, peak: boolean): string {
  const r = `${runs} run${runs === 1 ? "" : "s"}${km != null ? `, about ${Math.round(km)} km` : ""}`;
  switch (ph) {
    case "recovery":
      return `Lighter week to absorb the training: ${r}.`;
    case "taper":
      return `Taper: less running, keep some intensity. ${r}.`;
    case "race":
      return "Race week.";
    default:
      return i === 0 ? `First week: close to what you run now. ${r}.` : peak ? `Peak week: from here the volume holds while the sessions get more race-specific. ${r}.` : i === n - 1 ? `Last week. ${r}.` : `${r}.`;
  }
}

const VOLUME_LABEL: Record<VolumePref, string> = { gradual: "Gradual", steady: "Steady", progressive: "Progressive" };
const INTENSITY_LABEL: Record<IntensityPref, string> = { comfortable: "Comfortable", balanced: "Balanced", challenging: "Challenging" };

interface Shape {
  runs: number;
  volume: VolumePref;
  intensity: IntensityPref;
  auto: boolean;
  deloadEvery: number;
  rate: number;
}

function summarize(goal: Goal, b: Baseline, weeks: PlanWeek[], workouts: PlannedWorkout[], pace: Pace, proj: Projection | null, c: LongCtx, sh: Shape): string[] {
  const out: string[] = [];
  const counts = new Map<Phase, number>();
  for (const w of weeks) counts.set(w.phase, (counts.get(w.phase) ?? 0) + 1);
  const order: Phase[] = ["base", "build", "specific", "recovery", "taper", "race"];
  const label: Record<Phase, string> = { base: "base", build: "build", specific: "race-specific", recovery: "recovery", taper: "taper", race: "race" };
  out.push(`${weeks.length} weeks: ${order.filter((p) => counts.get(p)).map((p) => `${counts.get(p)} ${label[p]}`).join(", ")}.`);
  out.push(`${sh.runs} runs a week${sh.auto ? " (one more than you run now, at least 3)" : ""}, ${VOLUME_LABEL[sh.volume].toLowerCase()} volume, ${INTENSITY_LABEL[sh.intensity].toLowerCase()} intensity.`);
  const wkm = (w: PlanWeek) => {
    const end = addDaysIso(w.start, 6);
    const ws = workouts.filter((x) => x.date >= w.start && x.date <= end);
    return ws.length && ws.every((x) => x.distanceM != null) ? ws.reduce((a, x) => a + (x.distanceM ?? 0), 0) / 1000 : null;
  };
  const training = weeks.filter((w) => w.phase !== "taper" && w.phase !== "race");
  const peak = training.reduce((a, w) => (w.targetMinutes > a.targetMinutes ? w : a), training[0] ?? weeks[0]);
  if (peak) {
    const k0 = wkm(weeks[0]);
    const kp = wkm(peak);
    const amt = (w: PlanWeek, km: number | null) => (km != null ? `${Math.round(km)} km (${hm(w.targetMinutes)})` : hm(w.targetMinutes));
    out.push(`Weekly running goes from ${amt(weeks[0], k0)} to ${amt(peak, kp)} at most, then holds there instead of growing further; you have averaged ${hm(b.weeklyMinutes)} over the last 4 weeks.`);
  }
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
  out.push(`Load limits: weekly running grows at most ${Math.round(sh.rate * 100)} % a week, a lighter week every ${sh.deloadEvery} weeks, no run more than 10 % bigger than your biggest in the previous 30 days, and at most ${Math.round(HARD_SHARE_MAX * 100)} % of running time at threshold or harder.`);
  if (pace.note) out.push(pace.note);
  return out;
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min` : `${Math.round(min)} min`);
