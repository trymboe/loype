import { addDaysIso, weekStart } from "../dates";
import { runLoad } from "./running-load";

/**
 * Weekly running volume (calculated). Weeks are Monday–Sunday in local time.
 * Weeks without runs are included as zero so gaps are visible, not hidden.
 * Only running counts: walks/hikes that reach the activity table (when Garmin
 * gave no type and the FIT says walking) are not running volume.
 */
export const isRun = (sport: string | null | undefined) => sport === "running";

export interface WeekVolume {
  weekStart: string;
  distanceM: number;
  movingS: number;
  runs: number;
  longestM: number;
  /** running load, equivalent km (running-load.ts) */
  loadKm: number;
}

export function weeklyVolume(
  acts: { id?: string; local_date: string; distance_m: number | null; moving_s: number | null; elevation_gain_m?: number | null; sport?: string | null }[],
  fromWeek: string,
  toDate: string,
  /** time in HR zones / intensity per activity id, for the load */
  intensity?: Map<string, { zoneSeconds: number[] | null; intensity: number | null }>,
): WeekVolume[] {
  const weeks = new Map<string, WeekVolume>();
  for (let w = weekStart(fromWeek); w <= toDate; w = addDaysIso(w, 7)) {
    weeks.set(w, { weekStart: w, distanceM: 0, movingS: 0, runs: 0, longestM: 0, loadKm: 0 });
  }
  for (const a of acts) {
    if (a.sport !== undefined && !isRun(a.sport)) continue;
    const w = weeks.get(weekStart(a.local_date));
    if (!w) continue;
    w.distanceM += a.distance_m ?? 0;
    w.movingS += a.moving_s ?? 0;
    w.runs += 1;
    w.longestM = Math.max(w.longestM, a.distance_m ?? 0);
    w.loadKm += runLoad({ distanceM: a.distance_m, elevationGainM: a.elevation_gain_m, ...(a.id ? intensity?.get(a.id) : undefined) });
  }
  return [...weeks.values()];
}
