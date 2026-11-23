/**
 * What the Plan page shows per week, taken from the workouts as they are now
 * rather than from the planner's original targets, so the chart and labels
 * follow every change you or the coach make. Pure.
 */
import { addDaysIso } from "../dates";
import type { Phase, PlanWeek } from "./types";

export interface WeekView {
  start: string;
  index: number;
  phase: Phase;
  /** planned minutes of the week's runs (skipped ones left out) */
  minutes: number;
}

export function weekViews(weeks: PlanWeek[], workouts: { date: string; type: string; status: string; duration_s: number }[]): WeekView[] {
  const out: WeekView[] = [];
  for (const w of weeks) {
    const end = addDaysIso(w.start, 6);
    const items = workouts.filter((x) => x.date >= w.start && x.date <= end && x.type !== "rest" && x.status !== "skipped");
    const minutes = items.length ? Math.round(items.reduce((a, x) => a + x.duration_s / 60, 0)) : w.targetMinutes;
    let phase = w.phase;
    // a recovery week that was planned back up to a normal week (e.g. you asked to skip it) is no longer one
    const prev = out.at(-1);
    if (phase === "recovery" && prev && prev.minutes > 0 && minutes >= prev.minutes * 0.9) phase = prev.phase;
    out.push({ start: w.start, index: w.index, phase, minutes });
  }
  return out;
}
