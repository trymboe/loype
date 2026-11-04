/**
 * Route geometry: pure helpers for planned routes. Coordinates are [lng, lat]
 * (GeoJSON order) in degrees; distances in metres.
 */
import { haversine } from "@/lib/analytics/geo";

export type LngLat = [number, number];

const R = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function segmentLength(a: LngLat, b: LngLat): number {
  return haversine(a[1], a[0], b[1], b[0]);
}

/** Cumulative distance along the line, starting at 0. */
export function cumulativeDistance(coords: LngLat[]): number[] {
  const out = coords.length ? [0] : [];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + segmentLength(coords[i - 1], coords[i]));
  return out;
}

export function lineLength(coords: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += segmentLength(coords[i - 1], coords[i]);
  return d;
}

/** Point reached by travelling `distM` from `from` on initial bearing `bearingDeg` (great circle). */
export function destination(from: LngLat, bearingDeg: number, distM: number): LngLat {
  const φ1 = toRad(from[1]);
  const λ1 = toRad(from[0]);
  const θ = toRad(bearingDeg);
  const δ = distM / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((toDeg(λ2) + 540) % 360) - 180, toDeg(φ2)];
}

/**
 * Douglas–Peucker simplification with a tolerance in metres (local equirectangular
 * projection, accurate at route scale). Keeps first and last points.
 */
export function simplify<T extends readonly number[]>(coords: T[], toleranceM = 2): T[] {
  if (coords.length <= 2) return coords.slice();
  const lat0 = toRad(coords[0][1]);
  const kx = Math.cos(lat0) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  const xy = coords.map((c) => [c[0] * kx, c[1] * ky] as const);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Joins consecutive segments, dropping the duplicated joint point. */
export function joinSegments(segments: LngLat[][]): LngLat[] {
  const out: LngLat[] = [];
  for (const s of segments) {
    for (let i = 0; i < s.length; i++) {
      const last = out[out.length - 1];
      if (i === 0 && last && last[0] === s[0][0] && last[1] === s[0][1]) continue;
      out.push(s[i]);
    }
  }
  return out;
}

export interface ElevationStats {
  gainM: number;
  lossM: number;
  minM: number | null;
  maxM: number | null;
}

/**
 * Total ascent/descent with a hysteresis threshold: a climb only counts once the
 * elevation has moved `thresholdM` from the last turning point. This removes
 * DEM/barometer noise that would otherwise inflate gain on flat routes.
 */
export function elevationStats(elevations: (number | null)[], thresholdM = 3): ElevationStats {
  const vals = elevations.filter((e): e is number => e != null && Number.isFinite(e));
  if (vals.length === 0) return { gainM: 0, lossM: 0, minM: null, maxM: null };
  let gain = 0;
  let loss = 0;
  let ref = vals[0];
  for (const e of vals) {
    if (e - ref >= thresholdM) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= thresholdM) {
      loss += ref - e;
      ref = e;
    }
  }
  return { gainM: gain, lossM: loss, minM: Math.min(...vals), maxM: Math.max(...vals) };
}

/**
 * Picks at most `max` evenly spaced indices (always including both ends), so a
 * long route can be sent to an elevation service in one request.
 */
export function sampleIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}

/** Fills elevations for all points from samples at `idx`, interpolating by distance. */
export function interpolateAlong(coords: LngLat[], idx: number[], sampled: (number | null)[]): (number | null)[] {
  const cum = cumulativeDistance(coords);
  const out: (number | null)[] = new Array(coords.length).fill(null);
  const known = idx.map((i, k) => [i, sampled[k]] as const).filter(([, e]) => e != null) as [number, number][];
  if (!known.length) return out;
  let k = 0;
  for (let i = 0; i < coords.length; i++) {
    while (k + 1 < known.length && known[k + 1][0] <= i) k++;
    const [ia, ea] = known[k];
    if (i <= ia || k + 1 >= known.length) {
      out[i] = i < known[0][0] ? known[0][1] : ea;
      continue;
    }
    const [ib, eb] = known[k + 1];
    const span = cum[ib] - cum[ia];
    const t = span > 0 ? (cum[i] - cum[ia]) / span : 0;
    out[i] = ea + (eb - ea) * t;
  }
  return out;
}

/**
 * Waypoints for a loop of roughly `targetM` through `start`: `n` points on a
 * circle whose centre lies from the start in direction `bearingDeg`. Streets
 * are longer than the circle, so the radius is shrunk by `detour` (≈1.3 in
 * typical towns); generateLoop() then corrects it from the routed length.
 */
export function loopWaypoints(start: LngLat, targetM: number, bearingDeg: number, n = 3, detour = 1.3): LngLat[] {
  const r = targetM / (2 * Math.PI * detour);
  const centre = destination(start, bearingDeg, r);
  const back = (bearingDeg + 180) % 360; // bearing from centre to start
  const pts: LngLat[] = [start];
  for (let k = 1; k <= n; k++) pts.push(destination(centre, back + (360 * k) / (n + 1), r));
  pts.push(start);
  return pts;
}

/** Normalises [lng, lat] input and rejects anything outside valid ranges. */
export function isLngLat(v: unknown): v is LngLat {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 90
  );
}

/** Inserts points so no step is longer than `maxStepM` (map matching wants dense input). */
export function densify(coords: LngLat[], maxStepM: number): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const n = Math.ceil(segmentLength(a, b) / maxStepM);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    out.push(b);
  }
  return out;
}
