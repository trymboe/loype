/**
 * Links recorded runs to planned workouts and judges how each was executed.
 * Pure. A run is never forced onto a workout: weak matches stay unscheduled,
 * and an unmatched past workout is "missed" only after a day of grace.
 */
import { daysBetween } from "../dates";
import type { RunFeatures } from "../analytics/fitness/features";
import { formatPace } from "../units";
import { isHard, type Step, type Target, type WorkoutType } from "./types";

export interface MatchWorkout {
  id: string;
  date: string;
  type: WorkoutType;
  durationS: number;
  status: string;
  activityId: string | null;
}

export interface MatchRun {
  id: string;
  date: string;
  movingS: number | null;
  classification: string | null;
}

export interface MatchResult {
  matches: { workoutId: string; activityId: string; score: number }[];
  missed: string[];
}

const HARD_CLASSES = new Set(["threshold", "intervals", "race"]);

export function matchScore(w: MatchWorkout, r: MatchRun): number {
  const dd = Math.abs(daysBetween(w.date, r.date));
  if (dd > 1) return 0;
  let s = dd === 0 ? 1 : 0.6;
  if (r.movingS && w.durationS) {
    const ratio = r.movingS / w.durationS;
    s -= Math.min(0.5, Math.abs(Math.log(ratio)) * 0.5);
  }
  if (r.classification && r.classification !== "unknown") {
    const runHard = HARD_CLASSES.has(r.classification);
    if (runHard === isHard(w.type)) s += 0.1;
    else s -= 0.1;
  }
  return Math.round(Math.max(0, s) * 100) / 100;
}

export const MATCH_THRESHOLD = 0.4;

export function matchRuns(workouts: MatchWorkout[], runs: MatchRun[], today: string): MatchResult {
  const open = workouts.filter((w) => w.type !== "rest" && w.status !== "skipped" && !w.activityId && w.date <= today);
  const taken = new Set(workouts.map((w) => w.activityId).filter(Boolean) as string[]);
  const pairs: { w: MatchWorkout; r: MatchRun; score: number }[] = [];
  for (const w of open) for (const r of runs) if (!taken.has(r.id)) pairs.push({ w, r, score: matchScore(w, r) });
  pairs.sort((a, b) => b.score - a.score);
  const usedW = new Set<string>();
  const usedR = new Set<string>();
  const matches: MatchResult["matches"] = [];
  for (const p of pairs) {
    if (p.score < MATCH_THRESHOLD || usedW.has(p.w.id) || usedR.has(p.r.id)) continue;
    usedW.add(p.w.id);
    usedR.add(p.r.id);
    matches.push({ workoutId: p.w.id, activityId: p.r.id, score: p.score });
  }
  const missed = open.filter((w) => !usedW.has(w.id) && w.status === "planned" && daysBetween(w.date, today) >= 2).map((w) => w.id);
  return { matches, missed };
}

export interface ExecutionRun {
  movingS: number | null;
  distanceM: number | null;
  avgHr: number | null;
  features: RunFeatures | null;
}

export interface Execution {
  durationRatio: number | null;
  /** positive = faster than the middle of the target range, % */
  paceDeltaPct: number | null;
  workPace: number | null;
  targetPace: [number, number] | null;
  avgHr: number | null;
  verdict: "as_planned" | "harder" | "easier" | "shorter" | "longer";
  notes: string[];
}

const WORK_ZONES = new Set(["marathon", "threshold", "interval", "repetition", "race"]);

/** The main work steps of a session: longest continuous work step, or one rep of the main repeat. */
function mainWork(steps: Step[]): { durationS: number; target: Target } | null {
  let best: { durationS: number; target: Target } | null = null;
  for (const s of steps) {
    if (s.kind === "repeat") {
      for (const x of s.steps) if (x.kind === "run" && WORK_ZONES.has(x.target.zone) && x.durationS && (!best || x.durationS > best.durationS)) best = { durationS: x.durationS, target: x.target };
    } else if (s.kind === "run" && WORK_ZONES.has(s.target.zone) && s.durationS && (!best || s.durationS > best.durationS)) best = { durationS: s.durationS, target: s.target };
  }
  return best;
}

export function assessExecution(w: { type: WorkoutType; durationS: number; steps: Step[] }, r: ExecutionRun): Execution {
  const notes: string[] = [];
  const durationRatio = r.movingS && w.durationS ? Math.round((r.movingS / w.durationS) * 100) / 100 : null;
  let paceDeltaPct: number | null = null;
  let workPace: number | null = null;
  let targetPace: [number, number] | null = null;
  let verdict: Execution["verdict"] = "as_planned";

  const work = mainWork(w.steps);
  if (work && work.target.paceFast != null && work.target.paceSlow != null && r.features) {
    targetPace = [work.target.paceFast, work.target.paceSlow];
    const mid = (work.target.paceFast + work.target.paceSlow) / 2;
    // best effort whose duration is closest to one work bout
    const efforts = r.features.bestEfforts;
    if (efforts.length) {
      const e = efforts.reduce((a, b) => (Math.abs(b.timeS - work.durationS) < Math.abs(a.timeS - work.durationS) ? b : a));
      if (e.timeS >= work.durationS * 0.4 && e.timeS <= work.durationS * 2.5) {
        workPace = Math.round(e.timeS / (e.distanceM / 1000));
        paceDeltaPct = Math.round(((mid - workPace) / mid) * 1000) / 10;
        if (workPace < work.target.paceFast * 0.97) {
          verdict = "harder";
          notes.push(`Work pace ${formatPace(workPace)}/km was faster than the target ${formatPace(work.target.paceFast)}–${formatPace(work.target.paceSlow)}/km.`);
        } else if (workPace > work.target.paceSlow * 1.03) {
          verdict = "easier";
          notes.push(`Work pace ${formatPace(workPace)}/km was slower than the target ${formatPace(work.target.paceFast)}–${formatPace(work.target.paceSlow)}/km.`);
        } else notes.push(`Work pace ${formatPace(workPace)}/km was on target.`);
      }
    }
  } else if (!isHard(w.type)) {
    const easy = w.steps.find((s) => s.kind === "run" && (s.target.zone === "easy" || s.target.zone === "recovery"));
    if (easy && easy.kind === "run") {
      if (r.avgHr && easy.target.hrMax && r.avgHr > easy.target.hrMax + 5) {
        verdict = "harder";
        notes.push(`Average HR ${Math.round(r.avgHr)} was above the easy ceiling of ${easy.target.hrMax}.`);
      } else if (r.movingS && r.distanceM && easy.target.paceFast && r.movingS / (r.distanceM / 1000) < easy.target.paceFast * 0.95 && !(r.avgHr && easy.target.hrMax && r.avgHr <= easy.target.hrMax)) {
        verdict = "harder";
        notes.push(`Average pace ${formatPace(r.movingS / (r.distanceM / 1000))}/km was quicker than easy pace.`);
      }
    }
  }
  if (durationRatio != null) {
    if (durationRatio < 0.75) {
      if (verdict === "as_planned") verdict = "shorter";
      notes.push(`${Math.round(durationRatio * 100)} % of the planned time.`);
    } else if (durationRatio > 1.3) {
      if (verdict === "as_planned") verdict = "longer";
      notes.push(`${Math.round(durationRatio * 100)} % of the planned time.`);
    }
  }
  return { durationRatio, paceDeltaPct, workPace, targetPace, avgHr: r.avgHr, verdict, notes };
}
