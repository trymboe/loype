/**
 * GPX course parsing for the race page. Pure and dependency-free so it runs
 * on the server and in tests. Reads track points (`trkpt`), falling back to
 * route points (`rtept`), with optional `<ele>`.
 *
 * Elevation from GPX files is noisy (GPS altitude, or DEM samples every few
 * metres), so gain/loss is counted on a distance-smoothed profile with a
 * small hysteresis, the same idea as Garmin and Strava use.
 */
import { haversine } from "../analytics/geo";

export const GPX_MAX_BYTES = 5 * 1024 * 1024;
/** Points kept for storage and drawing. */
export const COURSE_MAX_POINTS = 600;
const SMOOTH_WINDOW_M = 100;
const HYSTERESIS_M = 2;

/** [lng, lat, elevation (m) or null, cumulative distance (m)] */
export type CoursePoint = [number, number, number | null, number];

export interface Course {
  name: string | null;
  distanceM: number;
  gainM: number | null;
  lossM: number | null;
  minEleM: number | null;
  maxEleM: number | null;
  points: CoursePoint[];
}

export class GpxError extends Error {}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? Number(m[1]) : NaN;
};

export function parseGpx(xml: string): Course {
  if (xml.length > GPX_MAX_BYTES) throw new GpxError("That file is larger than 5 MB.");
  if (!/<gpx[\s>]/i.test(xml)) throw new GpxError("That doesn't look like a GPX file.");
  const nameMatch = xml.match(/<(?:trk|rte|metadata)>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
  const name = nameMatch ? decode(nameMatch[1].trim()).slice(0, 120) || null : null;

  const raw: { lat: number; lng: number; ele: number | null }[] = [];
  for (const tagName of ["trkpt", "rtept"]) {
    const re = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, "gi");
    for (const m of xml.matchAll(re)) {
      const lat = attr(m[1], "lat");
      const lng = attr(m[1], "lon");
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const e = m[2]?.match(/<ele>\s*([-\d.eE+]+)\s*<\/ele>/i);
      const ele = e ? Number(e[1]) : NaN;
      raw.push({ lat, lng, ele: Number.isFinite(ele) && ele > -500 && ele < 9000 ? ele : null });
    }
    if (raw.length) break;
  }
  if (raw.length < 2) throw new GpxError("No track or route points found in that file.");

  const dist: number[] = [0];
  for (let i = 1; i < raw.length; i++) dist.push(dist[i - 1] + haversine(raw[i - 1].lat, raw[i - 1].lng, raw[i].lat, raw[i].lng));
  const distanceM = dist[dist.length - 1];
  if (distanceM < 400) throw new GpxError("That course is shorter than 400 m.");

  const hasEle = raw.filter((p) => p.ele != null).length >= raw.length * 0.8;
  const smooth = hasEle ? smoothByDistance(raw.map((p) => p.ele), dist, SMOOTH_WINDOW_M) : null;
  const { gain, loss } = smooth ? gainLoss(smooth) : { gain: null, loss: null };
  const eles = smooth?.filter((e): e is number => e != null) ?? [];

  const all: CoursePoint[] = raw.map((p, i) => [round(p.lng, 6), round(p.lat, 6), smooth?.[i] != null ? round(smooth[i]!, 1) : null, Math.round(dist[i])]);
  return {
    name,
    distanceM: Math.round(distanceM),
    gainM: gain != null ? Math.round(gain) : null,
    lossM: loss != null ? Math.round(loss) : null,
    minEleM: eles.length ? Math.round(Math.min(...eles)) : null,
    maxEleM: eles.length ? Math.round(Math.max(...eles)) : null,
    points: downsample(all, COURSE_MAX_POINTS),
  };
}

/** Centred moving average over ±window/2 metres of course distance. */
export function smoothByDistance(ele: (number | null)[], dist: number[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < ele.length; i++) {
    while (hi < ele.length && dist[hi] <= dist[i] + window / 2) {
      if (ele[hi] != null) {
        sum += ele[hi]!;
        n++;
      }
      hi++;
    }
    while (dist[lo] < dist[i] - window / 2) {
      if (ele[lo] != null) {
        sum -= ele[lo]!;
        n--;
      }
      lo++;
    }
    out.push(n > 0 ? sum / n : null);
  }
  return out;
}

export function gainLoss(ele: (number | null)[], hysteresis = HYSTERESIS_M): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  let ref: number | null = null;
  for (const e of ele) {
    if (e == null) continue;
    if (ref == null) {
      ref = e;
      continue;
    }
    if (e - ref >= hysteresis) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= hysteresis) {
      loss += ref - e;
      ref = e;
    }
  }
  return { gain, loss };
}

/** Keeps first and last point and evenly spaced points by distance. */
export function downsample(points: CoursePoint[], max: number): CoursePoint[] {
  if (points.length <= max) return points;
  const total = points[points.length - 1][3];
  const out: CoursePoint[] = [points[0]];
  let j = 1;
  for (let k = 1; k < max - 1; k++) {
    const target = (total * k) / (max - 1);
    while (j < points.length - 1 && points[j][3] < target) j++;
    if (out[out.length - 1] !== points[j]) out.push(points[j]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Elevation at a course distance, linearly interpolated. */
export function elevationAt(points: CoursePoint[], d: number): number | null {
  if (!points.length) return null;
  let i = 1;
  while (i < points.length && points[i][3] < d) i++;
  if (i >= points.length) return points[points.length - 1][2];
  const a = points[i - 1];
  const b = points[i];
  if (a[2] == null || b[2] == null) return a[2] ?? b[2];
  const span = b[3] - a[3];
  return span > 0 ? a[2] + ((b[2] - a[2]) * (d - a[3])) / span : a[2];
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
