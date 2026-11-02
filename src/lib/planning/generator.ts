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
  type WorkoutType,
} from "./types";
import { buildWorkout, finalize, stepsDuration, type TargetContext } from "./workouts";

export const MIN_WEEKS = 2;
export const MAX_WEEKS = 24;

/** Highest weekly running time the plan builds to, by goal (minutes). */
const PEAK_MINUTES: Record<string, number> = { "5k": 240, "10k": 300, half: 360, marathon: 480, race: 360, general: 300, endurance: 360, consistency: 240, maintain: 300, volume: 420 };
/** Longest long run, minutes. */
const LONG_CAP: Record<string, number> = { "5k": 75, "10k": 90, half: 120, marathon: 150, race: 120, general: 90, endurance: 120, consistency: 75, maintain: 90, volume: 120 };
/** Weeks of taper including race week. */
const TAPER_WEEKS: Record<string, number> = { "5k": 1, "10k": 1, half: 2, marathon: 3, race: 2 };
const TAPER_FACTORS: Record<number, number[]> = { 1: [0.6], 2: [0.75, 0.5], 3: [0.8, 0.6, 0.4] };

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

/**
 * Realistic improvement over a plan: about 0.6 % of race time per week of
 * training, capped at 8 %. A heuristic, deliberately conservative.
 */
export const achievableGain = (weeks: number) => Math.min(0.08, 0.006 * weeks);

interface Pace {
  racePace: number | null;
  note: string | null;
  warning: string | null;
}

function choosePace(goal: Goal, b: Baseline, weeks: number): Pace {
  const d = goalDistance(goal);
  if (!d) return { racePace: null, note: null, warning: null };
  const pred = predictedPace(b, d);
  const goalPace = goal.targetTimeS ? goal.targetTimeS / (d / 1000) : null;
  if (pred == null) {
    return {
      racePace: goalPace,
      note: goalPace ? `Race-pace work uses your target pace ${formatPace(goalPace)}/km; there is no fitness estimate yet to check it against.` : null,
      warning: goalPace ? null : "There is no fitness estimate yet, so race-pace sessions are by effort and heart rate. They get paces once the estimate appears.",
    };
  }
  const reachable = pred * (1 - achievableGain(weeks));
  if (goalPace == null) {
    return { racePace: pred, note: `Race pace ${formatPace(pred)}/km is your current predicted pace; it is recalibrated as your fitness changes.`, warning: null };
  }
  if (goalPace >= reachable) {
    return { racePace: goalPace, note: `Race pace ${formatPace(goalPace)}/km is your target pace (predicted now: ${formatPace(pred)}/km).`, warning: null };
  }
  const tgt = fmtTime(goal.targetTimeS!);
  const pr = fmtTime((pred * d) / 1000);
  return {
    racePace: reachable,
    note: `Race pace ${formatPace(reachable)}/km: the fastest that looks realistic in ${weeks} weeks from your current prediction.`,
    warning: `Your target ${tgt} is ${Math.round((1 - goalPace / pred) * 100)} % faster than your current prediction (${pr}). Typical gains over ${weeks} weeks are up to ${Math.round(achievableGain(weeks) * 100)} %, so the plan trains at ${formatPace(reachable)}/km and moves toward your target if your fitness improves.`,
  };
}

function planWeeks(goal: Goal, config: PlanConfig): { start: string; weeks: number; warnings: string[] } {
  const warnings: string[] = [];
  let start = weekStart(config.startDate);
  if (goal.raceDate) {
    const raceWeek = weekStart(goal.raceDate);
    let n = Math.floor(daysBetween(start, raceWeek) / 7) + 1;
    if (n > MAX_WEEKS) {
      start = addDaysIso(raceWeek, -7 * (MAX_WEEKS - 1));
      warnings.push(`The race is more than ${MAX_WEEKS} weeks away, so the plan starts on ${start}. Until then, keep running as you do now.`);
      n = MAX_WEEKS;
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

export function generatePlan(goal: Goal, config: PlanConfig, baseline: Baseline): GeneratedPlan {
  const warnings: string[] = [];
  const { start, weeks: n, warnings: w0 } = planWeeks(goal, config);
  warnings.push(...w0);
  const lowConsistency = baseline.consistency < 0.6;
  const phases = assignPhases(goal, n, lowConsistency);
  const dist = goalDistance(goal);
  const dk = distanceKey(dist);
  const pace = choosePace(goal, baseline, n);
  if (pace.warning) warnings.push(pace.warning);
  const raceLabel = raceLabelFor(goal);
  const ctx: TargetContext = { baseline, racePace: pace.racePace, raceLabel };
  if (!baseline.paceZones) warnings.push(baseline.hrZones ? "No fitness estimate yet, so sessions use heart-rate targets only. Paces are added once the estimate is available." : "No fitness estimate or heart-rate zones yet, so sessions are described by effort.");

  // days
  const unavailable = new Set(config.unavailableDays);
  const days = [...new Set(config.runDays)].filter((d) => d >= 0 && d <= 6 && !unavailable.has(d)).sort((a, b) => a - b);
  if (days.length === 0) days.push(1, 3, 5);
  if (days.length < config.runDays.length) warnings.push("Some run days were also marked unavailable; those days were left out.");
  const longDay = config.includeLongRuns ? (config.longRunDay != null && days.includes(config.longRunDay) ? config.longRunDay : days.includes(6) ? 6 : days.includes(5) ? 5 : days[days.length - 1]) : null;
  const qualityDays = pickQualityDays(days, longDay, days.length >= 4 ? 2 : days.length === 3 ? 1 : 0);

  // volume
  const startMin = Math.max(baseline.weeklyMinutes, days.length * 20);
  let peak = PEAK_MINUTES[dk ?? goal.kind] ?? 300;
  if (goal.kind === "volume" && goal.targetWeeklyKm) {
    const easy = baseline.paceZones?.find((z) => z.key === "easy");
    const pace = easy ? (easy.fastSPerKm + easy.slowSPerKm) / 2 : 390;
    peak = Math.round((goal.targetWeeklyKm * pace) / 60);
  }
  if (goal.kind === "maintain") peak = startMin;
  if (config.maxWeeklyMinutes) {
    if (baseline.weeklyMinutes > config.maxWeeklyMinutes) warnings.push(`You have averaged ${baseline.weeklyMinutes} min a week lately, more than your limit of ${config.maxWeeklyMinutes} min. The plan stays at your limit.`);
    peak = Math.min(peak, config.maxWeeklyMinutes);
  }
  peak = Math.max(peak, Math.min(startMin, config.maxWeeklyMinutes ?? Infinity));
  if (baseline.weeklyMinutes < 60 && baseline.consistency < 0.5) warnings.push("You have run little in the last weeks, so the plan starts gently and builds slowly.");

  const weekly: number[] = [];
  let level = Math.min(startMin, peak);
  const growth = lowConsistency ? 0.06 : 0.1;
  const taperIdx = phases.map((p, i) => (p === "taper" || p === "race" ? i : -1)).filter((i) => i >= 0);
  const taperFactors = goal.raceDate ? (TAPER_FACTORS[taperIdx.length] ?? []) : [0.7];
  let peakLevel = level;
  for (let i = 0; i < n; i++) {
    const ph = phases[i];
    if (ph === "taper" || ph === "race") {
      const k = taperIdx.indexOf(i);
      weekly.push(Math.round(peakLevel * (taperFactors[k] ?? 0.6)));
      continue;
    }
    if (ph === "recovery") {
      weekly.push(Math.round(level * 0.7));
      continue;
    }
    if (i > 0 && phases[i - 1] !== "recovery") level = Math.min(peak, level + Math.min(level * growth, 30));
    else if (i > 0) level = Math.min(peak, level + Math.min(level * growth * 0.5, 15)); // back from a recovery week
    peakLevel = Math.max(peakLevel, level);
    weekly.push(Math.round(level));
  }

  // workouts
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
  const longCap = LONG_CAP[dk ?? goal.kind] ?? 90;
  let altern = 0;
  for (let i = 0; i < n; i++) {
    const ws = addDaysIso(start, i * 7);
    const ph = phases[i];
    const target = weekly[i];
    const progress = phaseLen(i) > 1 ? (i - phaseStart(i)) / (phaseLen(i) - 1) : 0.5;
    const raceDay = ph === "race" && goal.raceDate ? daysBetween(ws, goal.raceDate) : null;
    const list: { dow: number; spec: Parameters<typeof buildWorkout>[0]; why: string; key: boolean }[] = [];

    // long run
    let longMin = 0;
    if (longDay != null && ph !== "race") {
      const share = ph === "build" || ph === "specific" ? 0.3 : 0.27;
      const allowed = Math.min(longCap, longest + (i % 2 === 1 ? 10 : 5));
      longMin = Math.max(30, Math.min(allowed, Math.max(Math.round(target * share), Math.round(Math.min(longest * 0.8, target * 0.45)))));
      if (ph !== "recovery" && ph !== "taper") longest = Math.max(longest, longMin);
      if (ph === "taper") longMin = Math.min(longMin, Math.round(longest * 0.7));
      if (ph === "recovery") longMin = Math.max(30, Math.min(longMin, Math.round(longest * 0.75)));
      const withRacePace = ph === "specific" && (dk === "half" || dk === "marathon") && i % 2 === 0;
      const progressive = !withRacePace && ph === "build" && i % 2 === 1;
      list.push({
        dow: longDay,
        spec: { type: progressive ? "progressive_long" : "long", minutes: longMin, withRacePace, goalKey: dk, progress },
        why: whyLong(longMin, longest, baseline, ph, withRacePace, progressive),
        key: ph !== "recovery",
      });
    }

    // quality
    const q = qualityTypes(goal, dk, ph, config, altern++);
    const qDays = ph === "race" ? [] : qualityDays.slice(0, q.length);
    q.slice(0, qDays.length).forEach((t, k) => {
      list.push({ dow: qDays[k], spec: { type: t, progress, goalKey: dk, strides: t === "strides", compact: target < 150 }, why: whyQuality(t, ph, goal, baseline, pace.note), key: isHard(t) });
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
      const primer = days.filter((d) => d < rd && rd - d >= 2 && rd - d <= 4).pop();
      if (primer != null) {
        list.push({ dow: primer, spec: { type: "easy", minutes: 30, strides: true }, why: "A short run with strides keeps your legs sharp without tiring them before the race.", key: false });
      }
    }

    // easy runs fill the rest of the week's time
    const used = new Set(list.map((l) => l.dow));
    const flexible = (l: (typeof list)[number]) => l.spec.type === "strides" || (l.spec.type === "easy" && ph !== "race");
    const fixedMin = list.filter((l) => !flexible(l)).map((l) => stepsDuration(buildWorkout(l.spec, ctx).steps) / 60).reduce((a, b) => a + b, 0);
    const easyDays = days.filter((d) => !used.has(d));
    const easyCap = ph === "race" ? 30 : Math.max(30, Math.round(longMin * 0.8) || 70);
    const left = Math.max(0, target - fixedMin);
    const slots = easyDays.length + list.filter(flexible).length;
    const each = slots ? Math.round(Math.max(20, Math.min(easyCap, left / slots))) : 0;
    for (const l of list) if (flexible(l)) l.spec.minutes = each;
    for (const d of easyDays) {
      if (ph === "race" && raceDay != null && d === raceDay - 1) continue; // day before the race: rest
      const recovery = list.some((l) => isHard(l.spec.type) && (l.dow === d - 1 || (d === 0 && l.dow === 6)));
      list.push({
        dow: d,
        spec: { type: recovery ? "recovery" : "easy", minutes: recovery ? Math.min(each, 40) : each, strides: false },
        why: recovery
          ? "The day after a hard session: keep it short and very easy so you absorb the work."
          : `Easy running builds the aerobic base everything else rests on. Keep it conversational${baseline.hrZones ? `, heart rate under ${baseline.hrZones[1].maxBpm}` : ""}.`,
        key: false,
      });
    }

    for (const l of list.sort((a, b) => a.dow - b.dow)) {
      const date = addDaysIso(ws, l.dow);
      if (date < config.startDate) continue;
      if (goal.raceDate && date > goal.raceDate) continue;
      workouts.push(finalize(buildWorkout(l.spec, ctx), date, l.why, l.key));
    }
    weekRows.push({ index: i, start: ws, phase: ph, targetMinutes: target, note: weekNote(ph, i, n) });
  }

  // actual planned minutes per week (structured sessions don't divide exactly)
  for (const w of weekRows) {
    const end = addDaysIso(w.start, 6);
    w.targetMinutes = Math.round(workouts.filter((x) => x.date >= w.start && x.date <= end).reduce((a, x) => a + x.durationS / 60, 0));
  }

  if (weekRows.length && weekRows[0].targetMinutes > Math.max(60, baseline.weeklyMinutes * 1.5)) {
    warnings.push(
      `You have averaged ${baseline.weeklyMinutes} min a week lately, and the first week has ${weekRows[0].targetMinutes} min because each of your ${days.length} run days needs a minimum useful length. If that is too big a step, pick fewer run days.`,
    );
  }
  return {
    version: PLANNER_VERSION,
    goal,
    config: { ...config, runDays: days, longRunDay: longDay },
    baseline,
    weeks: weekRows,
    workouts,
    summary: summarize(goal, baseline, weekRows, workouts, pace),
    warnings,
    racePace: pace.racePace,
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

function whyLong(min: number, longest: number, b: Baseline, ph: Phase, racePace: boolean, prog: boolean): string {
  const parts = [`The long run builds endurance. ${min} min`];
  parts[0] += b.longestRunMinutes ? ` compared with your longest of ${b.longestRunMinutes} min in the last 8 weeks` : "";
  parts[0] += "; it grows by at most 10 min at a time.";
  if (ph === "recovery") parts.push("Shorter this week to recover.");
  if (ph === "taper") parts.push("Shortened for the taper.");
  if (racePace) parts.push("Goal-pace segments late in the run rehearse race day on tired legs.");
  if (prog) parts.push("Finish the last quarter a little faster to practise running strong when tired.");
  void longest;
  return parts.join(" ");
}

function weekNote(ph: Phase, i: number, n: number): string {
  switch (ph) {
    case "recovery":
      return "Lighter week to absorb the training.";
    case "taper":
      return "Taper: less running, keep some intensity.";
    case "race":
      return "Race week.";
    default:
      return i === 0 ? "First week: close to what you run now." : i === n - 1 ? "Last week." : "";
  }
}

function summarize(goal: Goal, b: Baseline, weeks: PlanWeek[], workouts: PlannedWorkout[], pace: Pace): string[] {
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
  if (pace.note) out.push(pace.note);
  return out;
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min` : `${Math.round(min)} min`);
