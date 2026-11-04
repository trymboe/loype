/**
 * Builds structured workouts (steps with pace/HR targets) from your zones.
 * When there is no fitness estimate, targets fall back to heart rate, and
 * without HR zones to a described effort, never to invented paces.
 */
import { formatPace } from "../units";
import type { Baseline, PlannedWorkout, Step, Target, WorkoutType, Zone } from "./types";
import { WORKOUT_LABEL } from "./types";

export interface TargetContext {
  baseline: Baseline;
  /** s/km for race-pace work, or null */
  racePace: number | null;
  raceLabel: string | null;
}

const EFFORT: Record<Zone, string> = {
  recovery: "very easy, shorter strides",
  easy: "conversational",
  steady: "steady, can still talk in sentences",
  marathon: "controlled, a few words at a time",
  threshold: "comfortably hard",
  interval: "hard, about 3–5 min all-out pace",
  repetition: "fast and relaxed, not a sprint",
  race: "race effort",
  hill: "strong uphill effort",
};

const ZONE_NAME: Record<Zone, string> = {
  recovery: "Recovery",
  easy: "Easy",
  steady: "Steady",
  marathon: "Marathon pace",
  threshold: "Threshold",
  interval: "Interval",
  repetition: "Repetition",
  race: "Race pace",
  hill: "Hill",
};

export function target(zone: Zone, ctx: TargetContext): Target {
  const pz = ctx.baseline.paceZones;
  const hz = ctx.baseline.hrZones;
  const pace = (key: string) => pz?.find((z) => z.key === key) ?? null;
  let fast: number | null = null;
  let slow: number | null = null;
  const easy = pace("easy");
  const mar = pace("marathon");
  switch (zone) {
    case "recovery":
      if (easy) [fast, slow] = [easy.slowSPerKm, easy.slowSPerKm + 30];
      break;
    case "easy":
      if (easy) [fast, slow] = [easy.fastSPerKm, easy.slowSPerKm];
      break;
    case "steady":
      if (easy && mar) [fast, slow] = [mar.slowSPerKm, easy.fastSPerKm];
      break;
    case "marathon":
    case "threshold":
    case "interval":
    case "repetition": {
      const z = pace(zone);
      if (z) [fast, slow] = [z.fastSPerKm, z.slowSPerKm];
      break;
    }
    case "race":
      if (ctx.racePace) [fast, slow] = [ctx.racePace * 0.99, ctx.racePace * 1.01];
      break;
    case "hill":
      break;
  }
  const z = (n: number) => hz?.find((h) => h.zone === n) ?? null;
  let hr: [number, number] | null = null;
  const span = (a: number, b: number) => (z(a) && z(b) ? ([z(a)!.minBpm, z(b)!.maxBpm] as [number, number]) : null);
  switch (zone) {
    case "recovery":
      hr = span(1, 1);
      break;
    case "easy":
      hr = span(1, 2);
      break;
    case "steady":
      hr = span(3, 3);
      break;
    case "marathon":
      hr = z(3) && z(4) ? [z(3)!.minBpm + Math.round((z(3)!.maxBpm - z(3)!.minBpm) / 2), z(4)!.minBpm + 3] : null;
      break;
    case "threshold":
      hr = span(4, 4);
      break;
    case "interval":
      hr = span(5, 5);
      break;
    default:
      hr = null; // too short for HR to settle, or race: run by pace/feel
  }
  if (fast != null) fast = Math.round(fast);
  if (slow != null) slow = Math.round(slow);
  const parts = [zone === "race" && ctx.raceLabel ? `${ctx.raceLabel} pace` : ZONE_NAME[zone]];
  if (fast != null && slow != null) parts.push(`${formatPace(fast)}–${formatPace(slow)}/km`);
  if (hr && zone !== "race") parts.push(`HR ${hr[0]}–${hr[1]}`);
  if (fast == null && !hr) parts.push(`(${EFFORT[zone]})`);
  return { zone, paceFast: fast, paceSlow: slow, hrMin: hr?.[0] ?? null, hrMax: hr?.[1] ?? null, label: parts.join(" · ") };
}

const run = (ctx: TargetContext, zone: Zone, durationS: number, note?: string): Step => ({ kind: "run", durationS, target: target(zone, ctx), ...(note ? { note } : {}) });
const wu = (ctx: TargetContext, s = 900): Step => ({ kind: "warmup", durationS: s, target: target("easy", ctx) });
const cd = (ctx: TargetContext, s = 600): Step => ({ kind: "cooldown", durationS: s, target: target("easy", ctx) });
const rec = (ctx: TargetContext, s: number, note = "easy jog"): Step => ({ kind: "recover", durationS: s, target: target("recovery", ctx), note });
const rep = (count: number, steps: Step[]): Step => ({ kind: "repeat", count, steps });

export function stepsDuration(steps: Step[]): number {
  return steps.reduce((a, s) => a + (s.kind === "repeat" ? s.count * stepsDuration(s.steps) : (s.durationS ?? 0)), 0);
}

/** Estimated distance from the middle of each step's pace range; null when any step has no pace. */
export function stepsDistance(steps: Step[]): number | null {
  let total = 0;
  for (const s of steps) {
    if (s.kind === "repeat") {
      const d = stepsDistance(s.steps);
      if (d == null) return null;
      total += s.count * d;
    } else {
      if (s.distanceM) {
        total += s.distanceM;
        continue;
      }
      const { paceFast, paceSlow } = s.target;
      if (paceFast == null || paceSlow == null) {
        if (s.target.zone === "hill" && s.durationS) {
          total += s.durationS * 3; // ~3 m/s uphill, rough
          continue;
        }
        return null;
      }
      total += (s.durationS ?? 0) / (((paceFast + paceSlow) / 2) / 1000);
    }
  }
  return Math.round(total / 100) * 100;
}

const roundMin = (s: number, to = 5) => Math.max(to, Math.round(s / 60 / to) * to) * 60;

export interface WorkoutSpec {
  type: WorkoutType;
  /** total minutes wanted for easy/long runs; ignored for structured sessions */
  minutes?: number;
  /** 0 = first week of the phase, 1 = last (sessions grow within a phase) */
  progress?: number;
  goalKey?: string | null;
  /** for "race": the race distance */
  distanceM?: number | null;
  /** long run with race-pace segments */
  withRacePace?: boolean;
  strides?: boolean;
  /** shorter warm-up/cool-down for low-volume weeks */
  compact?: boolean;
}

export interface Built {
  type: WorkoutType;
  title: string;
  objective: string;
  steps: Step[];
}

export function buildWorkout(spec: WorkoutSpec, ctx: TargetContext): Built {
  const p = Math.max(0, Math.min(1, spec.progress ?? 0));
  const lerp = (a: number, b: number) => a + (b - a) * p;
  const g = spec.goalKey ?? null;
  const W = spec.compact ? 600 : 900;
  const C = spec.compact ? 300 : 600;
  switch (spec.type) {
    case "easy":
    case "recovery": {
      const total = roundMin((spec.minutes ?? 40) * 60, 1);
      if (spec.strides) {
        const main = Math.max(15 * 60, total - 6 * 80);
        return {
          type: "strides",
          title: `${Math.round(main / 60)} min easy + 6 strides`,
          objective: "Aerobic volume with a little leg speed",
          steps: [run(ctx, "easy", main), rep(6, [run(ctx, "repetition", 20, "stride: smooth, quick, relaxed"), rec(ctx, 60, "walk or jog back")])],
        };
      }
      const zone = spec.type === "recovery" ? "recovery" : "easy";
      return { type: spec.type, title: `${Math.round(total / 60)} min ${spec.type === "recovery" ? "recovery" : "easy"}`, objective: spec.type === "recovery" ? "Loosen up and recover" : "Aerobic base", steps: [run(ctx, zone, total)] };
    }
    case "long":
    case "progressive_long": {
      const total = roundMin((spec.minutes ?? 70) * 60, 1);
      if (spec.withRacePace && ctx.racePace) {
        const n = g === "marathon" ? (p > 0.5 ? 3 : 2) : 2;
        // fit the race-pace segments inside the run's time (at least 20 min easy first, 10 min easy to finish)
        const room = Math.floor((total - 1800 - (n - 1) * 300) / n / 60);
        const seg = Math.max(5, Math.min(room, g === "marathon" ? Math.round(lerp(15, 25)) : Math.round(lerp(8, 15))));
        const work = n * (seg * 60 + 300);
        const easyBefore = Math.max(20 * 60, total - work - 600);
        return {
          type: "long",
          title: `${Math.round(total / 60)} min long run with ${n} × ${seg} min at ${ctx.raceLabel ?? "race"} pace`,
          objective: "Practise goal pace on tired legs",
          steps: [run(ctx, "easy", easyBefore), rep(n, [run(ctx, "race", seg * 60), rec(ctx, 300, "easy running")]), run(ctx, "easy", 600, "finish easy")],
        };
      }
      if (spec.type === "progressive_long") {
        const fast = roundMin(total * 0.25);
        return {
          type: "progressive_long",
          title: `${Math.round(total / 60)} min progressive long run`,
          objective: "Endurance, finishing strong",
          steps: [run(ctx, "easy", total - fast), run(ctx, g === "marathon" || g === "half" ? "marathon" : "steady", fast, "last part steady to marathon effort")],
        };
      }
      return { type: "long", title: `${Math.round(total / 60)} min long run`, objective: "Endurance", steps: [run(ctx, "easy", total)] };
    }
    case "threshold": {
      const repMin = Math.round(lerp(5, 10));
      const work = Math.round(lerp(16, 30));
      const n = Math.max(2, Math.round(work / repMin));
      return {
        type: "threshold",
        title: `${n} × ${repMin} min threshold`,
        objective: "Raise the pace you can sustain",
        steps: [wu(ctx, W), rep(n, [run(ctx, "threshold", repMin * 60), rec(ctx, repMin >= 8 ? 120 : 90)]), cd(ctx, C)],
      };
    }
    case "tempo": {
      const min = Math.round(lerp(15, 30) / 5) * 5;
      return {
        type: "tempo",
        title: `${min} min tempo`,
        objective: "Sustained, comfortably hard running",
        steps: [wu(ctx, W), run(ctx, min <= 20 ? "threshold" : "marathon", min * 60, min <= 20 ? undefined : "just below threshold"), cd(ctx, C)],
      };
    }
    case "vo2max": {
      const n = Math.round(lerp(4, 6));
      const repS = p > 0.5 ? 240 : 180;
      return {
        type: "vo2max",
        title: `${n} × ${repS / 60} min VO2max`,
        objective: "Raise your aerobic ceiling",
        steps: [wu(ctx, W), rep(n, [run(ctx, "interval", repS), rec(ctx, repS * 0.75)]), cd(ctx, C)],
      };
    }
    case "repetitions": {
      const n = Math.round(lerp(8, 12));
      return {
        type: "repetitions",
        title: `${n} × 1 min fast`,
        objective: "Speed and running economy",
        steps: [wu(ctx, W), rep(n, [run(ctx, "repetition", 60), rec(ctx, 120, "full recovery, walk or jog")]), cd(ctx, C)],
      };
    }
    case "hills": {
      const n = Math.round(lerp(6, 10));
      return {
        type: "hills",
        title: `${n} × 60 s hills`,
        objective: "Strength and power with low impact",
        steps: [wu(ctx, W), rep(n, [{ kind: "run", durationS: 60, target: target("hill", ctx), note: "uphill, strong but controlled" }, rec(ctx, 90, "jog back down")]), cd(ctx, C)],
      };
    }
    case "race_pace": {
      const label = ctx.raceLabel ?? "race";
      let main: Step[];
      let title: string;
      if (g === "5k") {
        const n = Math.round(lerp(4, 6));
        main = [rep(n, [run(ctx, "race", 180), rec(ctx, 120)])];
        title = `${n} × 3 min at ${label} pace`;
      } else if (g === "10k") {
        const n = Math.round(lerp(3, 4));
        main = [rep(n, [run(ctx, "race", 480), rec(ctx, 120)])];
        title = `${n} × 8 min at ${label} pace`;
      } else if (g === "half") {
        const seg = Math.round(lerp(10, 20) / 5) * 5;
        main = [rep(2, [run(ctx, "race", seg * 60), rec(ctx, 180)])];
        title = `2 × ${seg} min at ${label} pace`;
      } else {
        const min = Math.round(lerp(30, 60) / 5) * 5;
        main = [run(ctx, "race", min * 60)];
        title = `${min} min at ${label} pace`;
      }
      return { type: "race_pace", title, objective: "Rehearse goal pace", steps: [wu(ctx, W), ...main, cd(ctx, C)] };
    }
    case "race": {
      const d = spec.distanceM ?? null;
      const durationS = d && ctx.racePace ? Math.round((ctx.racePace * d) / 1000) : 3600;
      return {
        type: "race",
        title: ctx.raceLabel ? `Race: ${ctx.raceLabel}` : "Race",
        objective: "Race day",
        steps: [wu(ctx, 600), { kind: "run", durationS, ...(d ? { distanceM: d } : {}), target: target("race", ctx), note: "even pace; the first km should feel too easy" }],
      };
    }
    case "strides":
      return buildWorkout({ ...spec, type: "easy", strides: true }, ctx);
    case "rest":
      return { type: "rest", title: "Rest", objective: "Recovery", steps: [] };
  }
}

export function finalize(b: Built, date: string, why: string, key: boolean): PlannedWorkout {
  const durationS = stepsDuration(b.steps);
  return {
    date,
    type: b.type,
    title: b.title || WORKOUT_LABEL[b.type],
    objective: b.objective,
    why,
    steps: b.steps,
    durationS,
    distanceM: stepsDistance(b.steps),
    key,
  };
}
