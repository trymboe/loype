/**
 * Planned workout → Intervals.icu event (`intervals-text@1`).
 *
 * Workouts are sent as Intervals.icu's native workout text in `description`
 * (the representation Intervals.icu staff recommend, and the one that exports
 * to Garmin with targets intact). Syntax used:
 *   - section headers `Warmup`, `Cooldown`, `4x` (repeat), blank line around each block
 *   - durations `10m`, `30s`, `1m30s`; distances `1km`, `1.5km`, `400mtr` (`m` means minutes)
 *   - absolute pace ranges `4:50-5:05/km Pace`
 *   - heart rate as % of the max HR configured in Intervals.icu (`72-80% HR`)
 *   - text before the duration becomes the step cue shown on the watch
 *
 * Intervals.icu can't mix pace and HR targets within one workout, so each
 * workout uses one target kind: pace when every targeted step has a pace and
 * Intervals.icu has a Run threshold pace (needed for pace targets to reach
 * Garmin), otherwise heart rate, otherwise no targets (cues only).
 */
import { createHash } from "node:crypto";
import type { Step, Target } from "../../planning/types";

export const INTERVALS_ENCODER_VERSION = "intervals-text@1";

export interface EncodableWorkout {
  id: string;
  date: string; // YYYY-MM-DD, athlete-local
  title: string;
  objective: string;
  why?: string;
  steps: Step[];
  durationS: number;
}

export interface AthleteRunSettings {
  /** Intervals.icu has a Run threshold pace (required for pace targets on Garmin) */
  hasThresholdPace: boolean;
  /** max HR configured for Run in Intervals.icu; % HR targets resolve against it */
  maxHr: number | null;
}

export type TargetMode = "PACE" | "HR" | "NONE";

export interface IntervalsEvent {
  category: "WORKOUT";
  start_date_local: string;
  type: "Run";
  name: string;
  description: string;
  external_id: string;
  moving_time: number;
  target: "PACE" | "HR" | "AUTO";
}

export const externalIdFor = (plannedWorkoutId: string) => `loype-${plannedWorkoutId}`;

type Leaf = Exclude<Step, { kind: "repeat" }>;

function leaves(steps: Step[]): Leaf[] {
  return steps.flatMap((s) => (s.kind === "repeat" ? leaves(s.steps) : [s]));
}

export function chooseTargetMode(steps: Step[], athlete: AthleteRunSettings): TargetMode {
  const ls = leaves(steps);
  const paced = ls.filter((s) => s.target.paceFast != null && s.target.paceSlow != null);
  const hr = ls.filter((s) => s.target.hrMin != null && s.target.hrMax != null);
  if (athlete.hasThresholdPace && paced.length > 0 && paced.length === ls.filter((s) => s.target.zone !== "hill").length) return "PACE";
  if (athlete.maxHr && hr.length > 0) return "HR";
  if (athlete.hasThresholdPace && paced.length > 0) return "PACE";
  return "NONE";
}

const mmss = (s: number) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};

export function formatDurationToken(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${sec ? `${sec}s` : ""}`;
}

export function formatDistanceToken(metres: number): string {
  if (metres >= 1000 && Math.round(metres) % 100 === 0) {
    const km = Math.round(metres / 100) / 10;
    return `${km}km`;
  }
  return `${Math.round(metres)}mtr`;
}

function targetToken(t: Target, mode: TargetMode, athlete: AthleteRunSettings): string | null {
  if (mode === "PACE" && t.paceFast != null && t.paceSlow != null) {
    return t.paceFast === t.paceSlow ? `${mmss(t.paceFast)}/km Pace` : `${mmss(t.paceFast)}-${mmss(t.paceSlow)}/km Pace`;
  }
  if (mode === "HR" && t.hrMin != null && t.hrMax != null && athlete.maxHr) {
    const lo = Math.round((t.hrMin / athlete.maxHr) * 100);
    const hi = Math.max(lo, Math.round((t.hrMax / athlete.maxHr) * 100));
    return lo === hi ? `${lo}% HR` : `${lo}-${hi}% HR`;
  }
  return null;
}

/** Cue text shown on the watch: letters/digits only so it can't be mistaken for syntax. */
function cue(s: Leaf): string {
  const base = s.kind === "recover" ? "Recover" : s.kind === "warmup" ? "Warm up" : s.kind === "cooldown" ? "Cool down" : zoneCue(s.target.zone);
  return base.replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

function zoneCue(z: Target["zone"]): string {
  switch (z) {
    case "hill":
      return "Hill";
    case "repetition":
      return "Fast relaxed";
    case "interval":
      return "Interval";
    case "threshold":
      return "Threshold";
    case "marathon":
      return "Marathon pace";
    case "race":
      return "Race pace";
    case "steady":
      return "Steady";
    case "recovery":
      return "Recovery";
    default:
      return "Easy";
  }
}

function leafLine(s: Leaf, mode: TargetMode, athlete: AthleteRunSettings): string {
  const amount = s.distanceM ? formatDistanceToken(s.distanceM) : formatDurationToken(s.durationS ?? 60);
  const t = targetToken(s.target, mode, athlete);
  return `- ${cue(s)} ${amount}${t ? ` ${t}` : ""}`;
}

/** Workout text. Consecutive warm-up/cool-down steps get a section header; repeats become `Nx` blocks. */
export function encodeWorkoutText(steps: Step[], mode: TargetMode, athlete: AthleteRunSettings): string {
  const blocks: string[][] = [];
  let current: { header: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (current && current.lines.length) blocks.push(current.header ? [current.header, ...current.lines] : current.lines);
    current = null;
  };
  for (const s of steps) {
    if (s.kind === "repeat") {
      flush();
      // Intervals.icu doesn't support nested repeats: unroll inner repeats into the block
      const inner = s.steps.flatMap((x) => (x.kind === "repeat" ? Array.from({ length: x.count }, () => leaves(x.steps)).flat() : [x]));
      blocks.push([`${s.count}x`, ...inner.map((x) => leafLine(x as Leaf, mode, athlete))]);
      continue;
    }
    const header = s.kind === "warmup" ? "Warmup" : s.kind === "cooldown" ? "Cooldown" : null;
    if (!current || current.header !== header) {
      flush();
      current = { header, lines: [] };
    }
    current.lines.push(leafLine(s, mode, athlete));
  }
  flush();
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

export function buildIntervalsEvent(w: EncodableWorkout, athlete: AthleteRunSettings): { event: IntervalsEvent; mode: TargetMode; hash: string } {
  const mode = chooseTargetMode(w.steps, athlete);
  const text = encodeWorkoutText(w.steps, mode, athlete);
  // Only workout text: free-text lines without "- " can be read as section headers.
  const description = text;
  const event: IntervalsEvent = {
    category: "WORKOUT",
    start_date_local: `${w.date}T00:00:00`,
    type: "Run",
    name: w.title.slice(0, 80),
    description,
    external_id: externalIdFor(w.id),
    moving_time: Math.round(w.durationS),
    target: mode === "NONE" ? "AUTO" : mode,
  };
  const hash = createHash("sha256").update(INTERVALS_ENCODER_VERSION).update(JSON.stringify(event)).digest("hex").slice(0, 32);
  return { event, mode, hash };
}

/* ------------------------------------------------------------------ */
/* Checking what Intervals.icu parsed                                  */
/* ------------------------------------------------------------------ */

export interface ParseCheck {
  ok: boolean;
  expectedSteps: number;
  parsedSteps: number;
  expectedTargets: number;
  parsedTargets: number;
  problems: string[];
}

interface DocStep {
  reps?: number;
  steps?: DocStep[];
  duration?: number;
  distance?: number;
  pace?: unknown;
  hr?: unknown;
  _power?: unknown;
  power?: unknown;
}

function countDoc(steps: DocStep[] | undefined): { steps: number; targets: number } {
  let n = 0;
  let t = 0;
  for (const s of steps ?? []) {
    if (Array.isArray(s.steps) && s.steps.length) {
      const inner = countDoc(s.steps);
      const reps = s.reps ?? 1;
      n += reps * inner.steps;
      t += reps * inner.targets;
    } else {
      n += 1;
      if (s.pace != null || s.hr != null) t += 1;
    }
  }
  return { steps: n, targets: t };
}

function countOurs(steps: Step[], mode: TargetMode, athlete: AthleteRunSettings): { steps: number; targets: number } {
  let n = 0;
  let t = 0;
  for (const s of steps) {
    if (s.kind === "repeat") {
      const inner = countOurs(s.steps, mode, athlete);
      n += s.count * inner.steps;
      t += s.count * inner.targets;
    } else {
      n += 1;
      if (targetToken(s.target, mode, athlete)) t += 1;
    }
  }
  return { steps: n, targets: t };
}

/**
 * Compares Intervals.icu's parsed `workout_doc` with what we sent: same number
 * of steps (repeats expanded) and the same number of steps carrying a target.
 * A match means Intervals.icu understood the workout; it does NOT mean the
 * workout reached Garmin Connect or the watch.
 */
export function checkParsed(steps: Step[], mode: TargetMode, athlete: AthleteRunSettings, workoutDoc: { steps?: DocStep[] } | null | undefined): ParseCheck {
  const ours = countOurs(steps, mode, athlete);
  const theirs = countDoc(workoutDoc?.steps);
  const problems: string[] = [];
  if (!workoutDoc?.steps?.length) problems.push("Intervals.icu didn't parse any steps from the workout.");
  else {
    if (theirs.steps !== ours.steps) problems.push(`Intervals.icu read ${theirs.steps} steps; Løype sent ${ours.steps}.`);
    if (theirs.targets < ours.targets) problems.push(`Only ${theirs.targets} of ${ours.targets} targets were recognised.`);
  }
  return { ok: problems.length === 0, expectedSteps: ours.steps, parsedSteps: theirs.steps, expectedTargets: ours.targets, parsedTargets: theirs.targets, problems };
}
