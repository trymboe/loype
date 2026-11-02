/**
 * "If you follow this plan" race-time projection. A heuristic, labelled as
 * such in the UI: typical VDOT gains per week of structured training, scaled
 * by how much the plan raises your volume, with diminishing returns, and a
 * wide range. It is recomputed from your actual fitness as you train.
 */
import { predictTimeS } from "../analytics/fitness/vdot";
import { endurancePenalty } from "../analytics/fitness/estimate";

export interface Projection {
  distanceM: number;
  label: string;
  vdotNow: number;
  vdotProjected: number;
  nowS: number;
  projectedS: number;
  /** optimistic / conservative ends of the range */
  fastS: number;
  slowS: number;
  /** volume factor used, kept so later updates scale the same way */
  volumeFactor: number;
  trainingWeeks: number;
  longestPlannedM: number;
  asOf: string;
}

/** Typical VDOT gain per week of consistent training; smaller the fitter you are. */
export function weeklyGainRate(vdot: number): number {
  if (vdot < 40) return 0.3;
  if (vdot < 45) return 0.25;
  if (vdot < 50) return 0.2;
  if (vdot < 55) return 0.15;
  if (vdot < 60) return 0.1;
  return 0.06;
}

/** More running than you do now → more gain, with diminishing returns. */
export function volumeFactor(planAvgMinutes: number, baselineMinutes: number): number {
  const ratio = planAvgMinutes / Math.max(30, baselineMinutes);
  return Math.max(0.5, Math.min(1.2, 0.7 + 0.3 * Math.log2(Math.max(0.5, ratio))));
}

/** Effective weeks with diminishing returns (the 30th week adds much less than the 3rd). */
const effectiveWeeks = (w: number) => 16 * (1 - Math.exp(-Math.max(0, w) / 16));

export function vdotGain(vdot: number, weeks: number, vf: number, adherence = 1): number {
  return Math.min(0.12 * vdot, weeklyGainRate(vdot) * vf * effectiveWeeks(weeks) * adherence);
}

export function project(opts: {
  vdot: number;
  distanceM: number;
  label: string;
  trainingWeeks: number;
  volumeFactor: number;
  longestPlannedM: number;
  /** longest recent run, for the "now" time */
  currentLongestM: number;
  asOf: string;
  adherence?: number;
}): Projection {
  const gain = vdotGain(opts.vdot, opts.trainingWeeks, opts.volumeFactor, opts.adherence ?? 1);
  const pen = endurancePenalty(opts.distanceM, opts.longestPlannedM);
  const t = (v: number) => Math.round(predictTimeS(v, opts.distanceM) * (1 + pen));
  return {
    distanceM: opts.distanceM,
    label: opts.label,
    vdotNow: opts.vdot,
    vdotProjected: Math.round((opts.vdot + gain) * 10) / 10,
    nowS: Math.round(predictTimeS(opts.vdot, opts.distanceM) * (1 + endurancePenalty(opts.distanceM, opts.currentLongestM))),
    projectedS: t(opts.vdot + gain),
    fastS: t(opts.vdot + gain * 1.3),
    slowS: t(opts.vdot + gain * 0.4),
    volumeFactor: opts.volumeFactor,
    trainingWeeks: opts.trainingWeeks,
    longestPlannedM: opts.longestPlannedM,
    asOf: opts.asOf,
  };
}

/**
 * Re-projects from your current fitness: remaining training weeks, the same
 * volume factor as the plan, scaled by how many recent sessions you did.
 */
export function liveProjection(stored: Projection, opts: { vdot: number; remainingWeeks: number; adherence: number; currentLongestM: number; asOf: string }): Projection {
  return project({
    vdot: opts.vdot,
    distanceM: stored.distanceM,
    label: stored.label,
    trainingWeeks: opts.remainingWeeks,
    volumeFactor: stored.volumeFactor,
    longestPlannedM: Math.max(stored.longestPlannedM, opts.currentLongestM),
    currentLongestM: opts.currentLongestM,
    asOf: opts.asOf,
    adherence: Math.max(0.5, Math.min(1, opts.adherence)),
  });
}

/** Share of planned sessions in the last 4 weeks that were done (skipped ones you chose don't count against you). */
export function adherence(workouts: { date: string; status: string; type: string }[], today: string, from: string): number {
  const past = workouts.filter((w) => w.type !== "rest" && w.date < today && w.date >= from && (w.status === "completed" || w.status === "missed"));
  if (past.length < 3) return 1;
  return past.filter((w) => w.status === "completed").length / past.length;
}
