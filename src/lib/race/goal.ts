import { fmtDist } from "../analytics/fitness/estimate";
import { GOAL_DISTANCE, GOAL_LABEL, type GoalKind } from "../planning/types";

export interface RaceGoalInfo {
  id: string;
  name: string;
  distanceM: number;
  raceDate: string | null;
  targetTimeS: number | null;
}

/** Race details from a goals row, or null when the goal isn't a race distance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function raceGoalFromRow(g: any): RaceGoalInfo | null {
  if (!g) return null;
  const kind = g.kind as GoalKind;
  const distanceM: number | null = g.distance_m ?? GOAL_DISTANCE[kind] ?? null;
  if (!distanceM || distanceM <= 0) return null;
  const name = g.name?.trim() || (kind === "race" ? `${fmtDist(distanceM)} race` : GOAL_LABEL[kind].replace(/^Improve /, ""));
  return { id: g.id, name, distanceM, raceDate: g.race_date ?? null, targetTimeS: g.target_time_s ?? null };
}
