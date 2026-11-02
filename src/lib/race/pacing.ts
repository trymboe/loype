/**
 * Race-day pacing plan: splits per kilometre for a finish time, adjusted for
 * the course profile when a GPX course is known.
 *
 * Grade cost (heuristic, documented in docs/RACE.md): uphill costs about
 * 3.3 % more time per 1 % of grade; downhill gives back about 1.8 % per 1 %
 * down to -8 %, after which steeper descents stop helping (braking). This
 * follows Daniels' rule of thumb (uphill costs more than downhill returns)
 * rather than the metabolic Minetti curve, which overstates downhill speed
 * for real runners.
 *
 * Strategy: "even" holds the same effort all the way; "negative" runs the
 * first half about 1 % easier and the second half about 1 % harder, which
 * protects against the most common race mistake (going out too fast).
 */
import type { CoursePoint } from "./gpx";

export type Strategy = "even" | "negative";

export interface Split {
  /** 1-based kilometre number; the last one may be partial */
  index: number;
  startM: number;
  endM: number;
  /** average grade in % over the split, null without elevation */
  gradePct: number | null;
  gainM: number | null;
  lossM: number | null;
  paceSPerKm: number;
  splitS: number;
  /** elapsed time at the end of this split */
  cumS: number;
}

export interface PacingPlan {
  distanceM: number;
  targetS: number;
  strategy: Strategy;
  /** pace on flat ground at the same effort */
  flatPaceSPerKm: number;
  averagePaceSPerKm: number;
  splits: Split[];
  checkpoints: { label: string; distanceM: number; timeS: number }[];
  firstHalfS: number;
  secondHalfS: number;
  usesCourse: boolean;
}

export const UPHILL_COST_PER_PCT = 0.033;
export const DOWNHILL_GAIN_PER_PCT = 0.018;
const DOWNHILL_BEST_PCT = -8;
const MAX_GRADE_PCT = 25;
const STRATEGY_SWING = 0.01;

/** Time multiplier for running at a grade (in %), relative to flat at equal effort. */
export function gradeFactor(gradePct: number): number {
  const g = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, gradePct));
  if (g >= 0) return 1 + UPHILL_COST_PER_PCT * g;
  if (g >= DOWNHILL_BEST_PCT) return 1 + DOWNHILL_GAIN_PER_PCT * g;
  // past the sweet spot, each extra % of descent gives the benefit back
  const best = 1 + DOWNHILL_GAIN_PER_PCT * DOWNHILL_BEST_PCT;
  return best + DOWNHILL_GAIN_PER_PCT * (DOWNHILL_BEST_PCT - g);
}

interface Segment {
  from: number;
  to: number;
  grade: number | null;
  rise: number | null;
}

/** Course segments rescaled to the race distance (a GPX is rarely exact). */
function courseSegments(points: CoursePoint[] | null, distanceM: number): Segment[] | null {
  if (!points || points.length < 2) return null;
  const total = points[points.length - 1][3];
  if (total <= 0) return null;
  const scale = distanceM / total;
  const hasEle = points.every((p) => p[2] != null);
  if (!hasEle) return null;
  const segs: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = b[3] - a[3];
    if (len <= 0) continue;
    const rise = b[2]! - a[2]!;
    segs.push({ from: a[3] * scale, to: b[3] * scale, grade: (rise / len) * 100, rise: rise });
  }
  return segs.length ? segs : null;
}

export function pacingPlan(opts: { distanceM: number; targetS: number; strategy?: Strategy; course?: CoursePoint[] | null }): PacingPlan {
  const { distanceM, targetS } = opts;
  const strategy = opts.strategy ?? "negative";
  const segs = courseSegments(opts.course ?? null, distanceM);
  const half = distanceM / 2;

  // relative cost and profile of each kilometre
  const kms: { startM: number; endM: number; cost: number; grade: number | null; gain: number | null; loss: number | null }[] = [];
  for (let start = 0; start < distanceM - 1; start += 1000) {
    const end = Math.min(distanceM, start + 1000);
    const len = end - start;
    let cost = 0;
    let gain: number | null = null;
    let loss: number | null = null;
    let net: number | null = null;
    if (segs) {
      gain = 0;
      loss = 0;
      net = 0;
      for (const s of segs) {
        const o = Math.min(end, s.to) - Math.max(start, s.from);
        if (o <= 0) continue;
        const frac = o / (s.to - s.from);
        cost += o * gradeFactor(s.grade ?? 0);
        const r = (s.rise ?? 0) * frac;
        net += r;
        if (r > 0) gain += r;
        else loss -= r;
      }
    } else cost = len;
    // strategy: easier first half, harder second (split proportionally at the halfway point)
    if (strategy === "negative") {
      const firstPart = Math.max(0, Math.min(end, half) - start);
      const secondPart = len - firstPart;
      cost *= (firstPart * (1 + STRATEGY_SWING) + secondPart * (1 - STRATEGY_SWING)) / len;
    }
    kms.push({ startM: start, endM: end, cost, grade: net != null ? (net / len) * 100 : null, gain, loss });
  }

  const totalCost = kms.reduce((s, k) => s + k.cost, 0);
  const secondsPerCostMetre = targetS / totalCost;
  let cum = 0;
  const splits: Split[] = kms.map((k, i) => {
    const splitS = k.cost * secondsPerCostMetre;
    cum += splitS;
    const len = k.endM - k.startM;
    return {
      index: i + 1,
      startM: k.startM,
      endM: k.endM,
      gradePct: k.grade != null ? Math.round(k.grade * 10) / 10 : null,
      gainM: k.gain != null ? Math.round(k.gain) : null,
      lossM: k.loss != null ? Math.round(k.loss) : null,
      paceSPerKm: (splitS / len) * 1000,
      splitS,
      cumS: cum,
    };
  });

  const timeAt = (d: number) => {
    let t = 0;
    for (const s of splits) {
      if (d >= s.endM) t = s.cumS;
      else {
        t += (s.splitS * (d - s.startM)) / (s.endM - s.startM);
        break;
      }
    }
    return t;
  };
  const marks = [
    { label: "5 km", distanceM: 5000 },
    { label: "10 km", distanceM: 10_000 },
    { label: "Half way", distanceM: half },
    { label: "Half marathon", distanceM: 21_097.5 },
    { label: "30 km", distanceM: 30_000 },
  ];
  const checkpoints = marks
    .filter((m) => m.distanceM < distanceM - 500)
    .filter((m) => m.label === "Half way" || Math.abs(m.distanceM - half) > 300)
    .sort((a, b) => a.distanceM - b.distanceM)
    .map((m) => ({ ...m, timeS: Math.round(timeAt(m.distanceM)) }));
  const firstHalfS = timeAt(half);

  return {
    distanceM,
    targetS,
    strategy,
    flatPaceSPerKm: secondsPerCostMetre * 1000,
    averagePaceSPerKm: targetS / (distanceM / 1000),
    splits,
    checkpoints,
    firstHalfS: Math.round(firstHalfS),
    secondHalfS: Math.round(targetS - firstHalfS),
    usesCourse: segs != null,
  };
}
