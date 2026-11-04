/**
 * Decides what to send to / remove from Intervals.icu (`outbound@1`). Pure, so
 * it can be tested without a database or network.
 */
import { buildIntervalsEvent, type AthleteRunSettings, type IntervalsEvent, type TargetMode } from "../integrations/intervals/encode";
import type { Step } from "../planning/types";

export const OUTBOUND_VERSION = "outbound@1";
export const DEFAULT_WINDOW_DAYS = 14;

export interface OutboundWorkout {
  id: string;
  date: string;
  type: string;
  title: string;
  objective: string;
  steps: Step[];
  duration_s: number;
  status: string;
  /** the workout belongs to the active plan */
  active: boolean;
}

export interface SyncRow {
  id: string;
  planned_workout_id: string | null;
  external_id: string;
  workout_date: string;
  payload_hash: string | null;
  state: string;
}

export interface Upsert {
  workout: OutboundWorkout;
  event: IntervalsEvent;
  hash: string;
  mode: TargetMode;
  row: SyncRow | null;
}

export interface OutboundPlan {
  upserts: Upsert[];
  /** rows whose remote copy should be deleted */
  deletes: SyncRow[];
  unchanged: number;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export const sendable = (w: OutboundWorkout, today: string) => w.active && w.status === "planned" && w.type !== "rest" && w.steps.length > 0 && w.date >= today;

/** States that mean "Intervals.icu has the current version" — no need to resend unless the content changed. */
const SETTLED = new Set(["sent", "parsed", "mismatch", "on_watch"]);

export function planOutbound(opts: { today: string; windowDays?: number; workouts: OutboundWorkout[]; rows: SyncRow[]; athlete: AthleteRunSettings; force?: boolean }): OutboundPlan {
  const { today, workouts, rows, athlete } = opts;
  const end = addDays(today, (opts.windowDays ?? DEFAULT_WINDOW_DAYS) - 1);
  const rowByWorkout = new Map(rows.filter((r) => r.planned_workout_id).map((r) => [r.planned_workout_id!, r]));
  const live = rows.filter((r) => r.state !== "removed");

  const upserts: Upsert[] = [];
  let unchanged = 0;
  const keep = new Set<string>();
  for (const w of workouts) {
    if (!sendable(w, today)) continue;
    const row = rowByWorkout.get(w.id) ?? null;
    const tracked = row && row.state !== "removed";
    // new workouts are sent within the window; ones already on Intervals.icu stay in sync wherever they move
    if (w.date > end && !tracked) continue;
    keep.add(w.id);
    const { event, hash, mode } = buildIntervalsEvent({ id: w.id, date: w.date, title: w.title, objective: w.objective, steps: w.steps, durationS: w.duration_s }, athlete);
    if (!opts.force && row && row.payload_hash === hash && SETTLED.has(row.state)) {
      unchanged++;
      continue;
    }
    upserts.push({ workout: w, event, hash, mode, row });
  }
  // Remove remote copies of upcoming workouts that were deleted, skipped, turned into rest or dropped from the plan.
  // Past workouts are left alone: they're history on Intervals.icu too.
  const deletes = live.filter((r) => r.workout_date >= today && (!r.planned_workout_id || !keep.has(r.planned_workout_id)));
  return { upserts, deletes, unchanged };
}
