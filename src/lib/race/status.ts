/**
 * Race status: countdown, current prediction for the race distance and how
 * it compares with the target. Pure; the page passes in the stored fitness
 * estimate and (when the plan has one) the plan's projection.
 */
import { daysBetween, formatDay } from "../dates";
import { endurancePenalty, fmtTime, type Confidence } from "../analytics/fitness/estimate";
import { predictTimeS } from "../analytics/fitness/vdot";

export interface RaceGoal {
  name: string;
  distanceM: number;
  raceDate: string;
  targetTimeS: number | null;
}

export interface EstimateInput {
  vdot: number;
  lower: number;
  upper: number;
  confidence: Confidence;
}

export interface ProjectionInput {
  projectedS: number;
  fastS: number;
  slowS: number;
}

export interface RacePredictionNow {
  timeS: number;
  /** optimistic end (upper VDOT) */
  fastS: number;
  /** conservative end (lower VDOT) */
  slowS: number;
  confidence: Confidence;
  /** % slower applied because the race is much longer than your recent long runs */
  endurancePct: number;
}

export type Verdict = "ahead" | "in_range" | "projected" | "stretch" | "no_target" | "no_estimate";

export interface RaceStatus {
  daysToGo: number;
  weeksToGo: number;
  past: boolean;
  prediction: RacePredictionNow | null;
  projection: ProjectionInput | null;
  /** predicted − target (positive = slower than target) */
  gapS: number | null;
  /** VDOT that would predict the target time at your current long-run base */
  vdotForTarget: number | null;
  verdict: Verdict;
  headline: string;
  detail: string;
}

const rank: Confidence[] = ["low", "medium", "high"];

export function predictRace(distanceM: number, est: EstimateInput, longestRecentM: number): RacePredictionNow {
  const pen = endurancePenalty(distanceM, longestRecentM);
  const t = (v: number) => Math.round(predictTimeS(v, distanceM) * (1 + pen));
  const confidence = pen > 0 ? rank[Math.max(0, rank.indexOf(est.confidence) - (pen >= 0.06 ? 2 : 1))] : est.confidence;
  return { timeS: t(est.vdot), fastS: t(est.upper), slowS: t(est.lower), confidence, endurancePct: Math.round(pen * 100) };
}

/** Inverse of the prediction: the VDOT whose predicted time equals `timeS` (bisection). */
export function vdotFor(distanceM: number, timeS: number, longestRecentM: number): number {
  const pen = endurancePenalty(distanceM, longestRecentM);
  let lo = 20;
  let hi = 85;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (predictTimeS(mid, distanceM) * (1 + pen) > timeS) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

export function raceStatus(opts: {
  goal: RaceGoal;
  today: string;
  estimate: EstimateInput | null;
  longestRecentM: number;
  projection?: ProjectionInput | null;
}): RaceStatus {
  const { goal, today } = opts;
  const daysToGo = daysBetween(today, goal.raceDate);
  const past = daysToGo < 0;
  const prediction = opts.estimate ? predictRace(goal.distanceM, opts.estimate, opts.longestRecentM) : null;
  const projection = opts.projection ?? null;
  const target = goal.targetTimeS;
  const gapS = prediction && target ? prediction.timeS - target : null;
  const vdotForTarget = target ? vdotFor(goal.distanceM, target, opts.longestRecentM) : null;

  let verdict: Verdict;
  let headline: string;
  let detail: string;
  if (!prediction) {
    verdict = "no_estimate";
    headline = "No prediction yet";
    detail = "A prediction needs a fitness estimate, which comes from a few runs with reliable GPS and heart rate. A hard effort or time trial helps most.";
  } else if (!target) {
    verdict = "no_target";
    headline = `Predicted ${fmtTime(prediction.timeS)}`;
    detail = `Likely between ${fmtTime(prediction.fastS)} and ${fmtTime(prediction.slowS)}. Add a target time to see how far off it is.`;
  } else if (prediction.timeS <= target) {
    verdict = "ahead";
    headline = `On track: ${fmtTime(target - prediction.timeS)} inside your target`;
    detail = `Your current fitness already predicts ${fmtTime(prediction.timeS)}. The job now is to arrive healthy and rested.`;
  } else if (prediction.fastS <= target) {
    verdict = "in_range";
    headline = `${fmtTime(gapS!)} off target, within your likely range`;
    detail = `The target sits inside the range your current fitness allows (${fmtTime(prediction.fastS)}–${fmtTime(prediction.slowS)}). Consistent training should close the gap.`;
  } else if (projection && projection.fastS <= target) {
    verdict = "projected";
    headline = `${fmtTime(gapS!)} off target today`;
    detail =
      projection.projectedS <= target
        ? `If you follow the plan, the projection (${fmtTime(projection.projectedS)}) reaches the target.`
        : `Following the plan gives a projected ${fmtTime(projection.projectedS)}; the target is at the optimistic end of that range (${fmtTime(projection.fastS)}).`;
  } else {
    verdict = "stretch";
    headline = `${fmtTime(gapS!)} off target`;
    detail = `The target needs a fitness level (VDOT ${vdotForTarget}) above your current estimate (${opts.estimate!.vdot.toFixed(1)}). ${
      daysToGo > 56 ? "It's a stretch, but there is time to build." : "With the time left it's a stretch; a realistic goal is in the pacing plan below."
    }`;
  }
  if (past) {
    headline = `Race day was ${formatDay(goal.raceDate, { day: "numeric", month: "long" })}`;
    detail = "Set your next goal to keep the plan and predictions moving.";
  }

  return { daysToGo, weeksToGo: Math.floor(Math.max(0, daysToGo) / 7), past, prediction, projection, gapS, vdotForTarget, verdict, headline, detail };
}
