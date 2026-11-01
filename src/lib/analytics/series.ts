/**
 * Prepares stored streams for interactive charts.
 *
 * pace: speed is derived from the cumulative distance stream over a centred
 * window of ±PACE_WINDOW_S seconds of *moving* samples (raw 1 s GPS pace is
 * too noisy to read). Paused/stopped samples get pace = null so the chart
 * shows a gap instead of a misleading spike.
 */
export const PACE_WINDOW_S = 8;
export const SLOWEST_PACE_S_PER_KM = 15 * 60;

export interface ChartPoint {
  i: number; // index into the full-resolution streams
  t: number; // elapsed seconds
  d: number; // km
  pace: number | null; // s/km
  hr: number | null;
  cad: number | null;
  alt: number | null;
  lat: number | null;
  lng: number | null;
}

export interface StoredStreams {
  t: number[];
  distance: (number | null)[] | null;
  hr: (number | null)[] | null;
  cadence: (number | null)[] | null;
  altitude: (number | null)[] | null;
  lat: (number | null)[] | null;
  lng: (number | null)[] | null;
  motion_states: string | null;
}

export function buildChartSeries(s: StoredStreams, maxPoints = 1200): ChartPoint[] {
  const n = s.t.length;
  if (n === 0) return [];
  const dist = s.distance ?? new Array(n).fill(null);
  // moving[i] describes the interval ending at sample i
  const moving = (i: number) => (i === 0 ? true : (s.motion_states?.[i - 1] ?? "m") === "m");

  const pace: (number | null)[] = new Array(n).fill(null);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (!moving(i) || dist[i] == null) continue;
    while (s.t[lo] < s.t[i] - PACE_WINDOW_S) lo++;
    while (hi + 1 < n && s.t[hi + 1] <= s.t[i] + PACE_WINDOW_S) hi++;
    // only use the window if it doesn't straddle a pause
    let ok = true;
    for (let k = lo + 1; k <= hi; k++) if (!moving(k)) { ok = false; break; }
    const d0 = dist[lo];
    const d1 = dist[hi];
    const dt = s.t[hi] - s.t[lo];
    if (!ok || d0 == null || d1 == null || dt <= 0 || d1 <= d0) continue;
    const p = (dt / (d1 - d0)) * 1000;
    pace[i] = p <= SLOWEST_PACE_S_PER_KM ? p : null;
  }

  const stride = Math.max(1, Math.ceil(n / maxPoints));
  const out: ChartPoint[] = [];
  let lastD = 0;
  for (let i = 0; i < n; i += stride) {
    const d = dist[i] ?? lastD;
    lastD = d;
    out.push({
      i,
      t: s.t[i],
      d: d / 1000,
      pace: pace[i] != null ? Math.round(pace[i]!) : null,
      hr: s.hr?.[i] ?? null,
      cad: s.cadence?.[i] != null && s.cadence[i]! > 0 ? Math.round(s.cadence[i]!) : null,
      alt: s.altitude?.[i] != null ? Math.round(s.altitude[i]! * 10) / 10 : null,
      lat: s.lat?.[i] ?? null,
      lng: s.lng?.[i] ?? null,
    });
  }
  return out;
}
