/** Picks what's worth celebrating about a freshly synced run. Pure, so it can be unit tested. */

export interface RevealRunLike {
  id: string;
  local_date: string;
  distance_m: number | null;
  avg_speed_moving: number | null;
  moving_s: number | null;
}

export interface Highlight {
  kind: "longest" | "fastest" | "week" | "plan";
  text: string;
}

const MIN_PRIOR = 3; // a "record" against one or two runs isn't one
const MIN_PACE_DIST_M = 3000; // short strides shouldn't win "fastest pace"

function daysAgoLabel(days: number): string {
  if (days >= 330) return "in a year";
  if (days >= 56) return `in ${Math.round(days / 30.4)} months`;
  return `in ${Math.max(2, Math.round(days / 7))} weeks`;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);
}

/**
 * `prior` are the runs before this one (any order), going back as far as the caller looked.
 * `windowStart` is the first date the caller looked at, so "longest in N" never overclaims.
 */
export function revealHighlights(run: RevealRunLike, prior: RevealRunLike[], windowStart: string, weekStartIso: string): Highlight[] {
  const out: Highlight[] = [];
  const others = prior.filter((r) => r.id !== run.id && r.local_date <= run.local_date);

  const dist = run.distance_m ?? 0;
  if (dist > 0 && others.length >= MIN_PRIOR) {
    // most recent run at least as long as this one
    const beaten = others.filter((r) => (r.distance_m ?? 0) >= dist).sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0];
    const since = beaten ? dayDiff(run.local_date, beaten.local_date) : dayDiff(run.local_date, windowStart);
    if (since >= 14) out.push({ kind: "longest", text: `Longest run ${daysAgoLabel(since)}` });
  }

  const speed = run.avg_speed_moving ?? 0;
  if (dist >= MIN_PACE_DIST_M && speed > 0) {
    const comparable = others.filter((r) => (r.distance_m ?? 0) >= MIN_PACE_DIST_M && (r.avg_speed_moving ?? 0) > 0);
    if (comparable.length >= MIN_PRIOR) {
      const beaten = comparable.filter((r) => (r.avg_speed_moving ?? 0) >= speed).sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0];
      const since = beaten ? dayDiff(run.local_date, beaten.local_date) : dayDiff(run.local_date, windowStart);
      if (since >= 14) out.push({ kind: "fastest", text: `Fastest pace ${daysAgoLabel(since)}` });
    }
  }

  const thisWeek = [...others.filter((r) => r.local_date >= weekStartIso), run];
  const weekKm = thisWeek.reduce((s, r) => s + (r.distance_m ?? 0), 0) / 1000;
  const n = thisWeek.length;
  const ordinal = n === 1 ? "First" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
  out.push({ kind: "week", text: `${ordinal} run this week · ${weekKm.toFixed(1)} km` });
  return out;
}
