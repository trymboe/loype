/**
 * Rescheduled sessions. When a planned run is cancelled and a new one is put
 * in its place (the coach skips Saturday's easy run and adds one on Sunday,
 * or the weekly update fills a day you had just moved a run away from), the
 * old one is not a missed session: the week still has the run, on another
 * day. Pure.
 *
 * A skipped or missed workout counts as replaced when the same Monday-based
 * week has a workout of the same kind that you or the coach put there (source
 * "athlete") and that isn't itself skipped. Each replacement covers one
 * cancelled workout. Skipped or missed runs with no replacement still count.
 */
import { weekStart } from "../dates";
import { isHard, type WorkoutType } from "./types";

export interface ReplaceableWorkout {
  id: string;
  date: string;
  type: string;
  status: string;
  /** "generator" | "athlete" | "adaptation"; unknown counts as the generator's */
  source?: string | null;
}

/** Sessions that do the same job in a week: hard, long, a race or time trial, or an easy run. */
export function sessionKind(type: string): string {
  if (type === "race" || type === "time_trial") return type;
  if (type === "long" || type === "progressive_long") return "long";
  if (isHard(type as WorkoutType)) return "hard";
  return "easy";
}

/** Ids of skipped or missed workouts that another workout in the same week replaced. */
export function replacedIds(workouts: ReplaceableWorkout[]): Set<string> {
  const out = new Set<string>();
  const runs = workouts.filter((w) => w.type !== "rest");
  const used = new Set<string>();
  const cancelled = runs.filter((w) => w.status === "skipped" || w.status === "missed").sort((a, b) => a.date.localeCompare(b.date));
  for (const c of cancelled) {
    const ws = weekStart(c.date);
    const kind = sessionKind(c.type);
    const candidates = runs
      .filter((w) => w.id !== c.id && !used.has(w.id) && w.source === "athlete" && w.status !== "skipped" && weekStart(w.date) === ws && sessionKind(w.type) === kind)
      // a done replacement first, then the closest day
      .sort((a, b) => Number(b.status === "completed") - Number(a.status === "completed") || Math.abs(dayNum(a.date) - dayNum(c.date)) - Math.abs(dayNum(b.date) - dayNum(c.date)));
    const r = candidates[0];
    if (!r) continue;
    used.add(r.id);
    out.add(c.id);
  }
  return out;
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * For the weekly update: the freshly generated workouts that are still needed
 * next to the ones being kept (moved, edited, locked, done or skipped). A kept
 * workout takes the place of one generated workout of the same kind in its
 * week, the same day first, so a run you moved to Tuesday isn't planned again
 * on Monday. Generated workouts on a kept workout's day are always dropped.
 */
export function stillNeeded<G extends { date: string; type: string }>(generated: G[], kept: { date: string; type: string }[]): G[] {
  const keptDates = new Set(kept.map((k) => k.date));
  const dropped = new Set<G>();
  const runs = kept.filter((k) => k.type !== "rest");
  const pending: typeof runs = [];
  for (const k of runs) {
    const g = generated.find((x) => !dropped.has(x) && x.type !== "rest" && x.date === k.date && sessionKind(x.type) === sessionKind(k.type));
    if (g) dropped.add(g);
    else pending.push(k);
  }
  for (const k of pending) {
    const ws = weekStart(k.date);
    const g = generated
      .filter((x) => !dropped.has(x) && x.type !== "rest" && !keptDates.has(x.date) && weekStart(x.date) === ws && sessionKind(x.type) === sessionKind(k.type))
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(k.date)) - Math.abs(dayNum(b.date) - dayNum(k.date)))[0];
    if (g) dropped.add(g);
  }
  return generated.filter((g) => !dropped.has(g) && !keptDates.has(g.date));
}
