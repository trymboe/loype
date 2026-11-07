/**
 * Route suggestions for a planned workout: rank saved routes by how well their
 * distance fits the session, how hilly they are (flat for quality sessions,
 * hills are fine for easy and long runs), then favourites and recent use.
 * Pure: the caller loads routes and usage.
 */
import type { Step } from "@/lib/planning/types";

export interface SuggestWorkout {
  type: string;
  durationS: number | null;
  distanceM: number | null;
  steps?: Step[] | null;
}

export interface SuggestRoute {
  id: string;
  distanceM: number;
  elevationGainM: number | null;
  favorite: boolean;
  /** Last time the route was used or edited (ISO date or timestamp), if known. */
  lastUsed?: string | null;
}

export interface RankedRoute<R extends SuggestRoute = SuggestRoute> {
  route: R;
  score: number;
  /** Climb in metres per km, when the route's elevation is known. */
  climbPerKm: number | null;
}

/** Fallback easy pace (s/km) when the workout's steps carry none. */
export const DEFAULT_EASY_PACE = 390;

/** Sessions that run best on flat ground. */
const FLAT_TYPES = new Set(["threshold", "tempo", "vo2max", "repetitions", "race_pace", "time_trial", "timetrial"]);
/** Sessions that don't need suggesting (a race has its own course). */
const SKIP_TYPES = new Set(["rest", "race"]);

export const prefersFlat = (type: string) => FLAT_TYPES.has(type);
export const wantsRoute = (type: string) => !SKIP_TYPES.has(type);

/** Mid easy (or recovery) pace in s/km from the workout's steps, if any step has one. */
export function easyPaceFromSteps(steps: Step[] | null | undefined): number | null {
  for (const s of steps ?? []) {
    if (s.kind === "repeat") {
      const p = easyPaceFromSteps(s.steps);
      if (p != null) return p;
      continue;
    }
    const { zone, paceFast, paceSlow } = s.target;
    if ((zone === "easy" || zone === "recovery") && paceFast != null && paceSlow != null) return (paceFast + paceSlow) / 2;
  }
  return null;
}

/** The distance (m) to look for: the planned distance, else duration at easy pace. */
export function targetDistance(w: SuggestWorkout, easyPace?: number | null): number | null {
  if (w.distanceM && w.distanceM > 0) return w.distanceM;
  if (!w.durationS || w.durationS <= 0) return null;
  const pace = easyPaceFromSteps(w.steps) ?? easyPace ?? DEFAULT_EASY_PACE;
  return (w.durationS / pace) * 1000;
}

/** How far a route's distance may be from the target: 15 %, at least 1 km. */
export function distanceTolerance(targetM: number): number {
  return Math.max(1000, targetM * 0.15);
}

const DAY = 86_400_000;

/**
 * Lower is better. Distance off in percent, plus climb (m/km) weighted by the
 * session (heavily for flat sessions, lightly for easy/long), minus a bonus
 * for favourites and for routes used in the last 60 days.
 */
export function scoreRoute(r: SuggestRoute, targetM: number, flat: boolean, today: string): { score: number; climbPerKm: number | null } {
  const off = Math.abs(r.distanceM / targetM - 1) * 100;
  const climbPerKm = r.elevationGainM != null && r.distanceM > 0 ? r.elevationGainM / (r.distanceM / 1000) : null;
  // unknown elevation: assume moderately rolling
  const climb = climbPerKm ?? 8;
  const climbCost = flat ? climb * 1.2 : Math.max(0, climb - 15) * 0.15;
  let bonus = r.favorite ? 4 : 0;
  if (r.lastUsed) {
    const days = (Date.parse(today) - Date.parse(r.lastUsed.slice(0, 10))) / DAY;
    if (Number.isFinite(days) && days >= 0) bonus += 3 * Math.max(0, 1 - days / 60);
  }
  return { score: off + climbCost - bonus, climbPerKm };
}

/** The best routes for the workout (up to `limit`), within the distance tolerance. */
export function suggestRoutes<R extends SuggestRoute>(
  w: SuggestWorkout,
  routes: R[],
  { today, easyPace = null, limit = 3 }: { today: string; easyPace?: number | null; limit?: number },
): RankedRoute<R>[] {
  if (!wantsRoute(w.type)) return [];
  const target = targetDistance(w, easyPace);
  if (!target) return [];
  const tol = distanceTolerance(target);
  const flat = prefersFlat(w.type);
  return routes
    .filter((r) => Math.abs(r.distanceM - target) <= tol)
    .map((route) => ({ route, ...scoreRoute(route, target, flat, today) }))
    .sort((a, b) => a.score - b.score || a.route.id.localeCompare(b.route.id))
    .slice(0, limit);
}

/** Link to the route planner's loop mode, pre-filled with the target distance (and flat preference). */
export function loopPlannerHref(targetM: number, flat: boolean): string {
  const km = Math.min(30, Math.max(2, Math.round((targetM / 1000) * 2) / 2));
  return `/routes/new?mode=loop&km=${km}${flat ? "&flat=1" : ""}`;
}

/** Planner query params → initial loop settings. Ignores anything out of range. */
export function parsePlannerParams(q: Record<string, string | string[] | undefined>): { mode: "loop" | null; km: number | null; flat: boolean } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const kmRaw = Number(one(q.km));
  const km = Number.isFinite(kmRaw) && kmRaw >= 2 && kmRaw <= 30 ? Math.round(kmRaw * 2) / 2 : null;
  const mode = one(q.mode) === "loop" || km != null ? "loop" : null;
  return { mode, km, flat: one(q.flat) === "1" };
}
