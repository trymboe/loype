/**
 * Deterministic plan generator (`planner@1`). Pure: goal + availability +
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
import { buildWorkout, finalize, stepsDuration, type TargetContext } from "./workouts";
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
  // Frequency is measured, not chosen: your usual run length and how often you have run in the last 4 weeks.
  // Like volume, frequency may rise to at most ACWR_MAX × its own 4-week average (so 6 runs a week stays 6–7,
  // 2 a week can become 3), with 2 runs as the floor for someone starting from nothing.
  const runLen = baseline.habitualRunMinutes ?? 30;
  const SHORT_RUN = 22;
  const usual = config.usualRunsPerWeek != null && config.usualRunsPerWeek > 0 ? Math.min(7, config.usualRunsPerWeek) : null;
  const runHist = usual != null ? [usual, usual, usual, usual] : baseline.recentRunCounts?.length === 4 ? [...baseline.recentRunCounts] : [1, 1, 1, 1].map(() => Math.round(baseline.runsPerWeek));
  // a fixed number of runs a week, if you chose one (never more than the days you can run)
  const fixedRuns = config.runsPerWeek != null && config.runsPerWeek >= 1 ? Math.min(avail.length, Math.round(config.runsPerWeek)) : null;
  if (fixedRuns != null && config.runsPerWeek! > avail.length) warnings.push(`You asked for ${config.runsPerWeek} runs a week but ticked ${avail.length} days, so the plan uses ${avail.length}.`);
  const freqCap = () => {
    const m = runHist.slice(-4).reduce((a, b) => a + b, 0) / 4;
    return Math.min(avail.length, Math.max(2, Math.floor(m * ACWR_MAX + 0.5), m < 4 ? Math.round(m) + 1 : 0));
  };
  const longDay = config.includeLongRuns ? (config.longRunDay != null && avail.includes(config.longRunDay) ? config.longRunDay : avail.includes(6) ? 6 : avail.includes(5) ? 5 : avail[avail.length - 1]) : null;

  // --- volume ---------------------------------------------------------------
  // start from what you actually ran: the larger of last week and your 4-week average, one full step up
  // (at least 15 min), and never above 1.3× the 4-week average + 10 min
  const recent = baseline.recentWeeks?.length === 4 ? baseline.recentWeeks : [baseline.weeklyMinutes, baseline.weeklyMinutes, baseline.weeklyMinutes, baseline.weeklyMinutes];
  const chronic0 = recent.reduce((a, b) => a + b, 0) / 4;
  const anchor = Math.max(recent[3], chronic0);
  const startMin = Math.max(2 * 20, Math.min(anchor + Math.max(15, weeklyStep(anchor, baseline.consistency < 0.6)), chronic0 * ACWR_MAX + 10));
  let peak = PEAK_MINUTES[dk ?? goal.kind] ?? 300;
  if (goal.kind === "volume" && goal.targetWeeklyKm) {
    const easy = baseline.paceZones?.find((z) => z.key === "easy");
    const p = easy ? (easy.fastSPerKm + easy.slowSPerKm) / 2 : 390;
    peak = Math.round((goal.targetWeeklyKm * p) / 60);
  }
  if (goal.kind === "maintain") peak = Math.max(startMin, chronic0);
  if (config.maxWeeklyMinutes) {
    if (chronic0 > config.maxWeeklyMinutes) warnings.push(`You have averaged ${chronic0} min a week lately, more than your limit of ${config.maxWeeklyMinutes} min. The plan stays at your limit.`);
    peak = Math.min(peak, config.maxWeeklyMinutes);
  }
  peak = Math.max(peak, 45);

  const weekly: number[] = [];
  const history = [...recent];
  let level = Math.min(startMin, peak);
  const taperIdx = phases.map((p, i) => (p === "taper" || p === "race" ? i : -1)).filter((i) => i >= 0);
  const taperFactors = goal.raceDate ? (TAPER_FACTORS[taperIdx.length] ?? []) : [0.7];
  let peakLevel = level;
  for (let i = 0; i < n; i++) {
    const ph = phases[i];
    let w: number;
    if (ph === "taper" || ph === "race") w = peakLevel * (taperFactors[taperIdx.indexOf(i)] ?? 0.6);
    else if (ph === "recovery") w = level * 0.7;
    else {
      if (i > 0) level = Math.min(peak, level + weeklyStep(level, lowConsistency) * (phases[i - 1] === "recovery" ? 0.5 : 1));
      const chronic = history.slice(-4).reduce((a, b) => a + b, 0) / 4;
      level = Math.min(level, Math.max(startMin, chronic * ACWR_MAX));
      peakLevel = Math.max(peakLevel, level);
      w = level;
    }
    weekly.push(Math.round(w));
    history.push(w);
  }

  if (fixedRuns != null && weekly[0] / fixedRuns < 20)
    warnings.push(`Weekly time starts from what you have run lately (${weekly[0]} min), so ${fixedRuns} runs a week means short runs at first (about ${Math.round(weekly[0] / fixedRuns)} min). They get longer as the weekly time builds.`);

  // --- pace and projection --------------------------------------------------
  const easyZone = baseline.paceZones?.find((z) => z.key === "easy");
  const easyPace = easyZone ? (easyZone.fastSPerKm + easyZone.slowSPerKm) / 2 : 390;
  const trainingWeeks = phases.filter((p) => p !== "taper" && p !== "race").length;
  const avgPlan = weekly.filter((_, i) => phases[i] !== "taper" && phases[i] !== "race").reduce((a, b) => a + b, 0) / Math.max(1, trainingWeeks);
  const vf = volumeFactor(avgPlan, chronic0);
  const longCap = LONG_CAP[dk ?? goal.kind] ?? 90;
  const projDist = dist ?? 10_000;
  const projection =
    baseline.vdot != null
      ? project({
          vdot: baseline.vdot,
          distanceM: projDist,
          label: raceLabelFor(goal) ?? "10 km",
          trainingWeeks,
          volumeFactor: vf,
          longestPlannedM: (Math.min(longCap, baseline.longestRunMinutes + trainingWeeks * 5) * 60 * 1000) / easyPace,
          currentLongestM: (baseline.longestRunMinutes * 60 * 1000) / easyPace,
          asOf: baseline.asOf,
        })
      : null;
  const pace = choosePace(goal, baseline, projection);
  if (pace.warning) warnings.push(pace.warning);
  const raceLabel = raceLabelFor(goal);
  const ctx: TargetContext = { baseline, racePace: pace.racePace, raceLabel };

  // --- weeks ---------------------------------------------------------------
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
  let longest = Math.max(baseline.longestRunMinutes, 30);
  // single-session spike limit: longest session in the last 30 days (your real runs for the first 4 weeks, then the plan's)
  const ref30 = baseline.longestRun30Minutes ?? baseline.longestRunMinutes;
  // planned sessions so far; a week's cap uses only sessions from the 24 days before it starts, which lie in
  // every one of its days' 30-day windows, so the limit holds for each day of the week
  const sessions: { date: string; min: number }[] = [];
  const spikeCap = (ws: string) => {
    const from = addDaysIso(ws, -24);
    const prior = sessions.filter((x) => x.date >= from && x.date < ws).map((x) => x.min);
    return Math.max(SPIKE_FLOOR_MIN, Math.floor(SPIKE_MAX * Math.max(from <= baseline.asOf ? ref30 : 0, ...prior)));
  };
  let lastRuns = 0;
  let altern = 0;
  let buildWeeks = 0;
  for (let i = 0; i < n; i++) {
    const ws = addDaysIso(start, i * 7);
    const ph = phases[i];
    const target = weekly[i];
    const progress = phaseLen(i) > 1 ? (i - phaseStart(i)) / (phaseLen(i) - 1) : 0.5;
    const raceDay = ph === "race" && goal.raceDate ? daysBetween(ws, goal.raceDate) : null;

    // runs this week: the week's time divided by your usual run length, capped by your frequency history.
    // As the week grows past where you started, runs get longer as well as more frequent (growth split
    // roughly evenly), so extra time does not all turn into extra days.
    const lenW = Math.min(Math.max(runLen, 60), runLen * Math.sqrt(Math.max(1, target / startMin)));
    // Prefer one more run over longer runs while the week can hold runs of at least SHORT_RUN minutes:
    // up to your habit plus one (at least 3) for low-frequency runners, your habit once you run 4+ a week.
    const habit = Math.round(runHist.slice(-4).reduce((a, b) => a + b, 0) / 4);
    const extra = Math.min(Math.floor(target / SHORT_RUN), Math.max(3, habit < 4 ? habit + 1 : habit));
    let runsW = Math.max(2, Math.min(freqCap(), Math.max(Math.round(target / lenW), extra)));
    if (ph !== "recovery" && ph !== "taper" && ph !== "race") buildWeeks++;
    if (ph === "recovery") runsW = Math.max(2, runsW - 1);
    // taper: keep frequency (cut volume, not runs)
    if (ph === "taper" || ph === "race") runsW = Math.min(avail.length, Math.max(runsW, lastRuns));
    else if (ph !== "recovery") lastRuns = runsW;
    // a fixed frequency holds every week; the week's time (still set by your load) is spread over those runs
    if (fixedRuns != null) runsW = fixedRuns;
    const cap = spikeCap(ws);
    // shortest runs: 20 min (25 for the long run), lower when a fixed frequency spreads a small week over many runs
    const minEasy = fixedRuns != null ? Math.max(10, Math.min(20, Math.floor(target / runsW) - 3)) : 20;
    const minLong = minEasy + 5;
    const days = spreadDays(avail, runsW, longDay);
    const wLong = longDay != null && days.includes(longDay) ? longDay : null;

    const list: { dow: number; spec: Parameters<typeof buildWorkout>[0]; why: string; key: boolean }[] = [];

    // long run
    let longMin = 0;
    if (wLong != null && ph !== "race") {
      const share = Math.max(ph === "build" || ph === "specific" ? 0.32 : 0.3, runsW <= 3 ? 1.1 / runsW : 0);
      const allowed = Math.min(longCap, longest + 5, cap);
      longMin = Math.max(minLong, Math.min(allowed, Math.max(Math.round(target * share), Math.round(Math.min(longest * 0.8, target * 0.4)))));
      if (ph !== "recovery" && ph !== "taper") longest = Math.max(longest, longMin);
      if (ph === "taper") longMin = Math.min(longMin, Math.round(longest * 0.7));
      if (ph === "recovery") longMin = Math.max(minLong, Math.min(longMin, Math.round(longest * 0.75)));
      const withRacePace = ph === "specific" && (dk === "half" || dk === "marathon") && i % 2 === 0;
      const progressive = !withRacePace && ph === "build" && i % 2 === 1;
      list.push({
        dow: wLong,
        spec: { type: progressive ? "progressive_long" : "long", minutes: longMin, withRacePace, goalKey: dk, progress },
        why: whyLong(longMin, baseline, ph, withRacePace, progressive),
        key: ph !== "recovery",
      });
    }

    // quality: hard sessions allowed by frequency, phase and how much you run now
    const lowBase = chronic0 < 90;
    let hardAllowed = runsW >= 4 ? 2 : runsW === 3 ? 1 : 0;
    if (ph === "base") hardAllowed = Math.min(hardAllowed, 1);
    if (lowBase && i < 2) hardAllowed = 0;
    const types = qualityTypes(goal, dk, ph, config, altern++);
    const hardTypes = types.filter((t) => isHard(t)).slice(0, hardAllowed);
    const spare = days.length - (wLong != null ? 1 : 0) - hardTypes.length;
    const extras = types.filter((t) => !isHard(t)).slice(0, Math.max(0, spare - 1));
    let q = [...hardTypes, ...extras];
    let qDays = ph === "race" ? [] : pickQualityDays(days, wLong, q.length);
    if (qDays.length < q.length) q = q.slice(0, qDays.length);
    // 80/20: shrink, then drop, hard sessions until the hard share fits
    let prog = q.map(() => progress);
    const hardShare = () => q.reduce((a, t, k) => a + (isHard(t) ? hardMinutes(buildWorkout({ type: t, progress: prog[k], goalKey: dk, compact: target < 150 }, ctx).steps) : 0), 0);
    while (q.some(isHard) && hardShare() > Math.max(12, target * HARD_SHARE_MAX)) {
      if (prog.some((p) => p > 0)) prog = prog.map((p) => Math.max(0, p - 0.25));
      else {
        const last = q.map(isHard).lastIndexOf(true);
        q = q.filter((_, k) => k !== last);
        prog = prog.filter((_, k) => k !== last);
        qDays = qDays.filter((_, k) => k !== last);
      }
    }
    q.forEach((t, k) => {
      list.push({ dow: qDays[k], spec: { type: t, progress: prog[k], goalKey: dk, strides: t === "strides", compact: target < 150 }, why: whyQuality(t, ph, goal, baseline, pace.note), key: isHard(t) });
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
          : `Race day.${pace.racePace ? ` Plan for about ${formatPace(pace.racePace)}/km and hold back in the first kilometre.` : ""}`,
        key: true,
      });
      const primer = avail.filter((d) => d < rd && rd - d >= 2 && rd - d <= 4).pop();
      if (primer != null) list.push({ dow: primer, spec: { type: "easy", minutes: 25, strides: true }, why: "A short run with strides keeps your legs sharp without tiring them before the race.", key: false });
      const opener = avail.filter((d) => primer != null && d < primer - 1).pop();
      if (opener != null) list.push({ dow: opener, spec: { type: "easy", minutes: 30 }, why: "Easy running to stay loose in race week.", key: false });
      // keep your usual frequency in race week with short easy runs (tapers cut volume, not frequency)
      for (const d of [...avail].reverse()) {
        if (list.length >= runsW) break;
        if (d >= rd - 1 || list.some((l) => l.dow === d)) continue;
        list.push({ dow: d, spec: { type: "easy", minutes: 20 }, why: "A short easy run: in a taper you cut volume but keep your usual rhythm of runs.", key: false });
      }
    }

    // easy runs fill the rest of the week's time on the chosen days
    const used = new Set(list.map((l) => l.dow));
    const flexible = (l: (typeof list)[number]) => l.spec.type === "strides" || (l.spec.type === "easy" && ph !== "race");
    const fixedMin = list.filter((l) => !flexible(l)).map((l) => stepsDuration(buildWorkout(l.spec, ctx).steps) / 60).reduce((a, b) => a + b, 0);
    const easyDays = ph === "race" ? [] : days.filter((d) => !used.has(d));
    const easyCap = Math.min(cap, Math.max(35, Math.round(longMin * 0.85) || 60));
    const left = Math.max(0, target - fixedMin);
    const slots = easyDays.length + list.filter(flexible).length;
    const each = slots ? Math.round(Math.max(minEasy, Math.min(easyCap, left / slots))) : 0;
    for (const l of list) if (flexible(l)) l.spec.minutes = each;
    for (const d of easyDays) {
      const afterHard = list.some((l) => isHard(l.spec.type) && (l.dow === d - 1 || (d === 0 && l.dow === 6)));
      list.push({
        dow: d,
        spec: { type: afterHard ? "recovery" : "easy", minutes: afterHard ? Math.min(each, 35) : each, strides: false },
        why: afterHard
          ? "The day after a hard session: keep it short and very easy so you absorb the work."
          : `Easy running builds the aerobic base everything else rests on. Keep it conversational${baseline.hrZones ? `, heart rate under ${baseline.hrZones[1].maxBpm}` : ""}.`,
        key: false,
      });
    }

    // keep the week within 10 % of its target: shorten easy runs, then the long run, then drop the last hard session
    const mins = (l: (typeof list)[number]) => stepsDuration(buildWorkout(l.spec, ctx).steps) / 60;
    for (let guard = 0; guard < 40 && ph !== "race"; guard++) {
      const planned = list.reduce((a, l) => a + mins(l), 0);
      if (planned <= target * 1.1) break;
      const easy = list.filter((l) => ["easy", "recovery", "strides"].includes(l.spec.type) && (l.spec.minutes ?? 0) > minEasy).sort((a, b) => (b.spec.minutes ?? 0) - (a.spec.minutes ?? 0))[0];
      const long = list.find((l) => (l.spec.type === "long" || l.spec.type === "progressive_long") && (l.spec.minutes ?? 0) > minLong);
      const hard = list.filter((l) => isHard(l.spec.type) && l.spec.type !== "race");
      if (easy) easy.spec.minutes = Math.max(minEasy, (easy.spec.minutes ?? minEasy) - 5);
      else if (long) long.spec.minutes = Math.max(minLong, (long.spec.minutes ?? minLong) - 5);
      else if (hard.some((h) => (h.spec.progress ?? 0) > 0)) for (const h of hard) h.spec.progress = Math.max(0, (h.spec.progress ?? 0) - 0.25);
      else if (hard.length) {
        const h = hard[hard.length - 1];
        h.spec = { type: "easy", minutes: 25, strides: config.includeStrides };
        h.key = false;
        h.why = "An easy run with strides instead of a hard session, to keep this week's total within a safe step from the last.";
      } else break;
    }

    // single-session spike limit: no run more than 10 % longer than the longest in the last 30 days
    for (const l of list) {
      if (l.spec.type === "race") continue;
      while (isHard(l.spec.type) && mins(l) > cap && (l.spec.progress ?? 0) > 0) l.spec.progress = Math.max(0, (l.spec.progress ?? 0) - 0.25);
      if (isHard(l.spec.type) && mins(l) > cap) {
        l.spec = { type: "easy", minutes: cap, strides: config.includeStrides };
        l.key = false;
        l.why = `An easy run instead of a hard session: with warm-up and cool-down it would be longer than ${cap} min, more than 10 % above your longest run in the last 30 days.`;
      }
      if (l.spec.minutes) for (let g = 0; g < 120 && mins(l) > cap && l.spec.minutes > 20; g++) l.spec.minutes -= 1;
    }
    for (const l of list) if (l.spec.type !== "race" && addDaysIso(ws, l.dow) >= config.startDate) sessions.push({ date: addDaysIso(ws, l.dow), min: mins(l) });

    for (const l of list.sort((a, b) => a.dow - b.dow)) {
      const date = addDaysIso(ws, l.dow);
      if (date < config.startDate) continue;
      if (goal.raceDate && date > goal.raceDate) continue;
      workouts.push(finalize(buildWorkout(l.spec, ctx), date, l.why, l.key));
    }
    weekRows.push({ index: i, start: ws, phase: ph, targetMinutes: target, note: weekNote(ph, i, n, list.length) });
    runHist.push(list.filter((l) => addDaysIso(ws, l.dow) >= config.startDate).length || runsW);
  }

  // planned minutes per week (structured sessions don't divide exactly)
  for (const w of weekRows) {
    const end = addDaysIso(w.start, 6);
    w.targetMinutes = Math.round(workouts.filter((x) => x.date >= w.start && x.date <= end).reduce((a, x) => a + x.durationS / 60, 0));
  }

  return {
    version: PLANNER_VERSION,
    goal,
    config: { ...config, runDays: avail, longRunDay: longDay, phases: undefined },
    baseline,
    weeks: weekRows,
    workouts,
    summary: summarize(goal, baseline, weekRows, workouts, pace, projection),
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
    if (speedy) return iv ? (flip ? ["threshold", "vo2max"] : ["vo2max", "threshold"]) : ["threshold", "tempo"];
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

function whyLong(min: number, b: Baseline, ph: Phase, racePace: boolean, prog: boolean): string {
  const parts = [`The long run builds endurance. ${min} min`];
  parts[0] += b.longestRunMinutes ? ` compared with your longest of ${b.longestRunMinutes} min in the last 8 weeks` : "";
  parts[0] += "; it grows by at most 5 min a week.";
  if (ph === "recovery") parts.push("Shorter this week to recover.");
  if (ph === "taper") parts.push("Shortened for the taper.");
  if (racePace) parts.push("Goal-pace segments late in the run rehearse race day on tired legs.");
  if (prog) parts.push("Finish the last quarter a little faster to practise running strong when tired.");
  return parts.join(" ");
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

function summarize(goal: Goal, b: Baseline, weeks: PlanWeek[], workouts: PlannedWorkout[], pace: Pace, proj: Projection | null): string[] {
  const out: string[] = [];
  const counts = new Map<Phase, number>();
  for (const w of weeks) counts.set(w.phase, (counts.get(w.phase) ?? 0) + 1);
  const order: Phase[] = ["base", "build", "specific", "recovery", "taper", "race"];
  const label: Record<Phase, string> = { base: "base", build: "build", specific: "race-specific", recovery: "recovery", taper: "taper", race: "race" };
  out.push(`${weeks.length} weeks: ${order.filter((p) => counts.get(p)).map((p) => `${counts.get(p)} ${label[p]}`).join(", ")}.`);
  const peak = weeks.reduce((a, w) => (w.targetMinutes > a.targetMinutes ? w : a), weeks[0]);
  if (peak) out.push(`Weekly running goes from ${hm(weeks[0].targetMinutes)} to a peak of ${hm(peak.targetMinutes)} in week ${peak.index + 1}; you have averaged ${hm(b.weeklyMinutes)} over the last 4 weeks.`);
  const longs = workouts.filter((w) => w.type === "long" || w.type === "progressive_long");
  if (longs.length) out.push(`Long run grows from ${Math.round(longs[0].durationS / 60)} to ${Math.round(Math.max(...longs.map((l) => l.durationS)) / 60)} min.`);
  const d = goalDistance(goal);
  if (d) {
    const pred = predictedPace(b, d);
    const bits: string[] = [];
    if (pred) bits.push(`predicted now ${fmtTime((pred * d) / 1000)}`);
    if (goal.targetTimeS) bits.push(`target ${fmtTime(goal.targetTimeS)}`);
    if (bits.length) out.push(`${goal.name ?? GOAL_LABEL[goal.kind]}: ${bits.join(", ")}.`);
  }
  if (proj) out.push(`If you follow it: ${proj.label} ${fmtTime(proj.nowS)} now → about ${fmtTime(proj.projectedS)} (range ${fmtTime(proj.slowS)}–${fmtTime(proj.fastS)}). This projection is a heuristic based on typical gains; it is updated from your actual fitness as you train.`);
  out.push(`Load limits: at most +10 % (or +10–30 min) a week, never more than ${ACWR_MAX}× your previous 4-week average, a lighter week every ${b.consistency < 0.6 ? 3 : 4} weeks, and at most ${Math.round(HARD_SHARE_MAX * 100)} % of running time at threshold or harder.`);
  if (pace.note) out.push(pace.note);
  return out;
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min` : `${Math.round(min)} min`);
