/**
 * Turns a coach's typed edit request into a plan-change proposal (`coach@1`).
 * Pure and deterministic: the coach only names *what* to change (which
 * workout, replace with easy/recovery/rest, or move to another day); the
 * workout content comes from the planner's own builder, and every request is
 * checked against the same rules as manual edits. The coach can only reduce
 * or keep load, never add it. Nothing is applied here: the result is a
 * pending proposal the athlete accepts or keeps, and can undo.
 */
import { daysBetween, formatDay } from "../dates";
import type { Change, WorkoutFields } from "../planning/adapt";
import { WORKOUT_LABEL, type Step, type WorkoutType } from "../planning/types";
import { moveIssues, type ScheduleItem } from "../planning/validate";
import { buildWorkout, stepsDistance, stepsDuration, type TargetContext } from "../planning/workouts";

export const COACH_VERSION = "coach@1";

export type CoachEdit =
  | { workoutId: string; action: "replace"; with: "easy" | "recovery" | "rest"; minutes?: number | null }
  | { workoutId: string; action: "move"; toDate: string };

export interface CoachWorkout {
  id: string;
  date: string;
  type: WorkoutType;
  title: string;
  objective: string;
  why: string;
  steps: Step[];
  durationS: number;
  distanceM: number | null;
  locked: boolean;
  status: string;
}

export interface CoachProposalInput {
  today: string;
  title: string;
  explanation: string;
  evidence: string[];
  edits: CoachEdit[];
  workouts: CoachWorkout[];
  ctx: TargetContext;
  unavailableDays: number[];
  /** last day of the plan (moves can't go past it) */
  planEnd: string;
}

export type CoachProposalResult =
  | { ok: true; title: string; explanation: string; evidence: string[]; changes: Change[]; warnings: string[] }
  | { ok: false; errors: string[] };

const fields = (w: CoachWorkout): WorkoutFields => ({
  type: w.type,
  title: w.title,
  objective: w.objective,
  why: w.why,
  steps: w.steps,
  durationS: w.durationS,
  distanceM: w.distanceM,
});

/** Longest move the coach may make, in days either way. */
const MAX_MOVE_DAYS = 7;

export function buildCoachProposal(input: CoachProposalInput): CoachProposalResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const changes: Change[] = [];
  const byId = new Map(input.workouts.map((w) => [w.id, w]));
  const seen = new Set<string>();
  // schedule after the moves so far, for move validation
  let schedule: ScheduleItem[] = input.workouts.map((w) => ({ id: w.id, date: w.date, type: w.type, status: w.status }));

  if (!input.edits.length) errors.push("No changes were given.");
  if (input.edits.length > 7) errors.push("Too many changes in one proposal (at most 7).");

  for (const e of input.edits) {
    const w = byId.get(e.workoutId);
    if (!w) {
      errors.push(`Workout ${e.workoutId} is not in the active plan.`);
      continue;
    }
    const label = `${w.title} on ${formatDay(w.date)}`;
    if (seen.has(w.id)) {
      errors.push(`${label} appears more than once.`);
      continue;
    }
    seen.add(w.id);
    if (w.status !== "planned") {
      errors.push(`${label} is ${w.status}, so it can't be changed.`);
      continue;
    }
    if (w.date < input.today) {
      errors.push(`${label} is in the past.`);
      continue;
    }
    if (w.locked) {
      errors.push(`${label} is locked by the athlete.`);
      continue;
    }
    if (w.type === "race") {
      errors.push(`${label} is the race itself and can't be changed by the coach.`);
      continue;
    }

    if (e.action === "replace") {
      if (e.with === w.type && e.minutes == null) {
        errors.push(`${label} is already a ${WORKOUT_LABEL[w.type].toLowerCase()}.`);
        continue;
      }
      const currentMin = Math.round(w.durationS / 60);
      let after: WorkoutFields;
      if (e.with === "rest") {
        const b = buildWorkout({ type: "rest" }, input.ctx);
        after = { type: b.type, title: b.title, objective: b.objective, why: "Rest day suggested by the coach.", steps: b.steps, durationS: 0, distanceM: null };
      } else {
        const fallback = Math.min(40, Math.max(20, Math.round(currentMin / 1.5)));
        let minutes = Math.round(e.minutes ?? fallback);
        if (minutes < 15) {
          warnings.push(`${label}: ${minutes} min is very short, so it was set to 15 min.`);
          minutes = 15;
        }
        // the coach can only reduce load: never longer than what was planned
        if (w.type !== "rest" && minutes > Math.max(15, currentMin)) {
          warnings.push(`${label}: kept at ${Math.max(15, currentMin)} min, the length already planned (the coach can't add load).`);
          minutes = Math.max(15, currentMin);
        }
        if (w.type === "rest") {
          errors.push(`${label} is a rest day; the coach doesn't add runs.`);
          continue;
        }
        const b = buildWorkout({ type: e.with, minutes }, input.ctx);
        after = {
          type: b.type,
          title: b.title,
          objective: b.objective,
          why: `${e.with === "recovery" ? "Recovery run" : "Easy run"} suggested by the coach in place of ${WORKOUT_LABEL[w.type].toLowerCase()}.`,
          steps: b.steps,
          durationS: stepsDuration(b.steps),
          distanceM: stepsDistance(b.steps),
        };
      }
      changes.push({ workoutId: w.id, date: w.date, before: fields(w), after });
    } else {
      const to = e.toDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        errors.push(`${label}: ${to} is not a date.`);
        continue;
      }
      if (to === w.date) {
        errors.push(`${label} is already on that day.`);
        continue;
      }
      if (to < input.today) {
        errors.push(`${label} can't be moved into the past.`);
        continue;
      }
      if (to > input.planEnd) {
        errors.push(`${label} can't be moved past the end of the plan (${formatDay(input.planEnd)}).`);
        continue;
      }
      if (Math.abs(daysBetween(w.date, to)) > MAX_MOVE_DAYS) {
        errors.push(`${label}: moves are limited to ${MAX_MOVE_DAYS} days either way.`);
        continue;
      }
      for (const i of moveIssues(schedule, w.id, to, input.unavailableDays)) warnings.push(i.message);
      schedule = schedule.map((s) => (s.id === w.id ? { ...s, date: to } : s));
      changes.push({ workoutId: w.id, date: w.date, toDate: to, before: fields(w), after: fields(w) });
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    title: input.title.trim().slice(0, 120),
    explanation: input.explanation.trim().slice(0, 1200),
    evidence: [...input.evidence.map((e) => e.trim()).filter(Boolean).slice(0, 8), ...warnings.map((w) => `Check: ${w}`)],
    changes,
    warnings,
  };
}
