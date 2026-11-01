import { addDaysIso, weekStart } from "../dates";

/**
 * Weekly running volume (calculated). Weeks are Monday–Sunday in local time.
 * Weeks without runs are included as zero so gaps are visible, not hidden.
 */
export interface WeekVolume {
  weekStart: string;
  distanceM: number;
  movingS: number;
  runs: number;
  longestM: number;
}

export function weeklyVolume(
  acts: { local_date: string; distance_m: number | null; moving_s: number | null }[],
  fromWeek: string,
  toDate: string,
): WeekVolume[] {
  const weeks = new Map<string, WeekVolume>();
  for (let w = weekStart(fromWeek); w <= toDate; w = addDaysIso(w, 7)) {
    weeks.set(w, { weekStart: w, distanceM: 0, movingS: 0, runs: 0, longestM: 0 });
  }
  for (const a of acts) {
    const w = weeks.get(weekStart(a.local_date));
    if (!w) continue;
    w.distanceM += a.distance_m ?? 0;
    w.movingS += a.moving_s ?? 0;
    w.runs += 1;
    w.longestM = Math.max(w.longestM, a.distance_m ?? 0);
  }
  return [...weeks.values()];
}
