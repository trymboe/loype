/** Planning types (`planner@3`). Durations in seconds, distances in metres, paces in s/km. */
import type { HrZone } from "../analytics/fitness/physiology";
import type { PaceZone } from "../analytics/fitness/vdot";
import type { Projection } from "./projection";

export const PLANNER_VERSION = "planner@3";

/** How much running the plan builds to (Runna-style): lower, medium or higher weekly volume and long runs. */
export type VolumePref = "gradual" | "steady" | "progressive";
/** How hard the quality sessions are and how many there are a week. */
export type IntensityPref = "comfortable" | "balanced" | "challenging";

export type GoalKind = "5k" | "10k" | "half" | "marathon" | "race" | "general" | "endurance" | "consistency" | "maintain" | "volume";

export const GOAL_LABEL: Record<GoalKind, string> = {
  "5k": "Improve 5 km",
  "10k": "Improve 10 km",
  half: "Half marathon",
  marathon: "Marathon",
  race: "Specific race",
  general: "General running fitness",
  endurance: "Aerobic endurance",
  consistency: "Run consistently",
  maintain: "Maintain fitness",
  volume: "Build weekly volume",
};

export const GOAL_DISTANCE: Partial<Record<GoalKind, number>> = { "5k": 5000, "10k": 10_000, half: 21_097.5, marathon: 42_195 };

export interface Goal {
  kind: GoalKind;
  name: string | null;
  /** race distance (from kind, or entered for "race") */
  distanceM: number | null;
  raceDate: string | null;
  targetTimeS: number | null;
  targetWeeklyKm: number | null;
}

export interface PlanConfig {
  startDate: string;
  /** start on startDate even when the race is further away than the usual longest plan */
  startNow?: boolean;
  /** used when there is no race date */
  weeks: number;
  /** days you are available to run, 0 = Monday … 6 = Sunday; how many of them are used comes from your load */
  runDays: number[];
  /** set when the plan is refreshed: keeps the original phase of each remaining week */
  phases?: Phase[];
  /** Monday of the week the future weeks were last recalculated from your actual running */
  refreshedWeek?: string;
  /** race-time projection made when the plan was created */
  projection?: Projection | null;
  /**
   * Runs per week. A number fixes it (capped by the days you ticked); null or missing lets the planner
   * choose from how often you have been running.
   */
  runsPerWeek?: number | null;
  /** training volume; missing means steady */
  volume?: VolumePref | null;
  /** session intensity; missing means balanced */
  intensity?: IntensityPref | null;
  /** how often you run now, entered by hand: replaces the measured frequency (e.g. without a watch connected) */
  usualRunsPerWeek?: number | null;
  longRunDay: number | null;
  unavailableDays: number[];
  maxWeeklyMinutes: number | null;
  includeIntervals: boolean;
  includeLongRuns: boolean;
  includeStrides: boolean;
  /** a time trial in week 1 as a baseline; missing means none */
  baselineTimeTrial?: boolean;
}

export interface Baseline {
  asOf: string;
  vdot: number | null;
  vdotRange: [number, number] | null;
  vdotConfidence: "high" | "medium" | "low" | null;
  paceZones: PaceZone[] | null;
  hrZones: HrZone[] | null;
  thresholdHr: number | null;
  /** average over the last 4 weeks */
  weeklyMinutes: number;
  weeklyKm: number;
  runsPerWeek: number;
  /** weeks with at least one run, out of the last 8 */
  consistency: number;
  longestRunMinutes: number;
  /** longest single run in the last 30 days (minutes): the reference for the single-session spike limit */
  longestRun30Minutes?: number;
  /** running minutes in each of the last 4 complete calendar weeks, oldest first */
  recentWeeks?: number[];
  /** runs (≥ 10 min) in each of those weeks, oldest first */
  recentRunCounts?: number[];
  /** median length of your runs over the last 8 weeks, minutes */
  habitualRunMinutes?: number | null;
  /** your runs of 10 min or more in the last 8 weeks, oldest first: session lengths and the spike limit are seeded from them */
  recentRuns?: BaselineRunSummary[];
  /** race-time predictions by distance (m → s) at the current estimate */
  predictions: { distanceM: number; timeS: number }[];
}

export interface BaselineRunSummary {
  date: string;
  minutes: number;
  km: number | null;
}

export type Zone = "recovery" | "easy" | "steady" | "marathon" | "threshold" | "interval" | "repetition" | "race" | "hill";

export interface Target {
  zone: Zone;
  paceFast: number | null;
  paceSlow: number | null;
  hrMin: number | null;
  hrMax: number | null;
  /** short human label, e.g. "Threshold 4:55–5:02/km" */
  label: string;
}

export type Step =
  | { kind: "warmup" | "cooldown" | "run" | "recover"; durationS?: number; distanceM?: number; target: Target; note?: string }
  | { kind: "repeat"; count: number; steps: Step[] };

export type WorkoutType =
  | "easy"
  | "recovery"
  | "long"
  | "progressive_long"
  | "threshold"
  | "tempo"
  | "vo2max"
  | "repetitions"
  | "hills"
  | "race_pace"
  | "strides"
  | "race"
  | "time_trial"
  | "rest";

export const WORKOUT_LABEL: Record<WorkoutType, string> = {
  easy: "Easy run",
  recovery: "Recovery run",
  long: "Long run",
  progressive_long: "Progressive long run",
  threshold: "Threshold intervals",
  tempo: "Tempo run",
  vo2max: "VO2max intervals",
  repetitions: "Short repetitions",
  hills: "Hill repeats",
  race_pace: "Race-pace session",
  strides: "Easy run + strides",
  race: "Race",
  time_trial: "Time trial",
  rest: "Rest",
};

export const HARD_TYPES: WorkoutType[] = ["threshold", "tempo", "vo2max", "repetitions", "hills", "race_pace", "race", "time_trial"];
export const isHard = (t: WorkoutType) => HARD_TYPES.includes(t);
export const isDemanding = (t: WorkoutType) => isHard(t) || t === "long" || t === "progressive_long";

export type Phase = "base" | "build" | "specific" | "taper" | "recovery" | "race";

export const PHASE_LABEL: Record<Phase, string> = {
  base: "Base",
  build: "Build",
  specific: "Race-specific",
  taper: "Taper",
  recovery: "Recovery week",
  race: "Race week",
};

export interface PlannedWorkout {
  date: string;
  type: WorkoutType;
  title: string;
  objective: string;
  why: string;
  steps: Step[];
  durationS: number;
  distanceM: number | null;
  /** key sessions are preserved first when the plan is adjusted */
  key: boolean;
  locked?: boolean;
}

export interface PlanWeek {
  index: number;
  start: string;
  phase: Phase;
  targetMinutes: number;
  note: string;
}

export interface GeneratedPlan {
  version: typeof PLANNER_VERSION;
  goal: Goal;
  config: PlanConfig;
  baseline: Baseline;
  weeks: PlanWeek[];
  workouts: PlannedWorkout[];
  summary: string[];
  warnings: string[];
  /** pace used for race-pace work, s/km */
  racePace: number | null;
  projection: Projection | null;
}
