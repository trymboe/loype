/**
 * Surface breakdown of a route, from OpenStreetMap `surface` tags as the
 * routing engine reports them per edge. Where a way has no tag, Valhalla
 * guesses from the way type (footways and tracks lean unpaved), so the result
 * is an estimate.
 */
import { segmentLength, type LngLat } from "./geometry";

export type SurfaceClass = "paved" | "rough" | "gravel" | "trail" | "unknown";

export const SURFACE_CLASSES: SurfaceClass[] = ["paved", "rough", "gravel", "trail", "unknown"];

export const SURFACE_LABEL: Record<SurfaceClass, string> = {
  paved: "Asphalt / paved",
  rough: "Cobbles / rough paved",
  gravel: "Gravel",
  trail: "Dirt / trail",
  unknown: "Unknown",
};

/** Map colours, chosen to read on the coloured base map (soft surfaces in earthy tones). */
export const SURFACE_COLOR: Record<SurfaceClass, string> = {
  paved: "#64748b",
  rough: "#a855f7",
  gravel: "#d97706",
  trail: "#16a34a",
  unknown: "#94a3b8",
};

/** Soft surfaces are easier on the legs than asphalt or cobbles. */
export const SOFT: SurfaceClass[] = ["gravel", "trail"];

/** Valhalla surface values: paved_smooth, paved, paved_rough, compacted, dirt, gravel, path, impassable. */
export function classifySurface(raw: string | null | undefined): SurfaceClass {
  switch (raw) {
    case "paved_smooth":
    case "paved":
      return "paved";
    case "paved_rough":
      return "rough";
    case "compacted":
    case "gravel":
      return "gravel";
    case "dirt":
    case "path":
      return "trail";
    default:
      return "unknown";
  }
}

export interface SurfaceEdge {
  surface?: string | null;
  begin_shape_index?: number;
  end_shape_index?: number;
  /** km */
  length?: number;
}

export interface SurfaceSegment {
  cls: SurfaceClass;
  coords: LngLat[];
}

export interface SurfaceSummary {
  totalM: number;
  /** Metres per class. */
  metres: Record<SurfaceClass, number>;
  /** Share of the known-surface distance that is gravel or trail, 0–100 (null when nothing is known). */
  softPct: number | null;
  /** Consecutive stretches of the same class, for colouring the map. */
  segments: SurfaceSegment[];
}

const empty = (): Record<SurfaceClass, number> => ({ paved: 0, rough: 0, gravel: 0, trail: 0, unknown: 0 });

/** Builds the summary from the matched shape and the edges along it. */
export function summarizeSurfaces(shape: LngLat[], edges: SurfaceEdge[]): SurfaceSummary {
  const metres = empty();
  const segments: SurfaceSegment[] = [];
  for (const e of edges) {
    const cls = classifySurface(e.surface);
    const b = e.begin_shape_index;
    const en = e.end_shape_index;
    let coords: LngLat[] = [];
    let len = 0;
    if (b != null && en != null && en > b && en < shape.length) {
      coords = shape.slice(b, en + 1);
      for (let i = 1; i < coords.length; i++) len += segmentLength(coords[i - 1], coords[i]);
    } else if (e.length != null) {
      len = e.length * 1000;
    }
    if (!(len > 0)) continue;
    metres[cls] += len;
    if (coords.length < 2) continue;
    const last = segments[segments.length - 1];
    if (last && last.cls === cls && last.coords[last.coords.length - 1] === coords[0]) last.coords.push(...coords.slice(1));
    else segments.push({ cls, coords });
  }
  const totalM = SURFACE_CLASSES.reduce((s, c) => s + metres[c], 0);
  const known = totalM - metres.unknown;
  const softPct = known > 0 ? ((metres.gravel + metres.trail) / known) * 100 : null;
  return { totalM, metres, softPct, segments };
}

/** Percentages per class that add up to 100 (largest remainder), for display. */
export function surfacePercents(metres: Record<SurfaceClass, number>): Record<SurfaceClass, number> {
  const total = SURFACE_CLASSES.reduce((s, c) => s + metres[c], 0);
  const out = empty();
  if (total <= 0) return out;
  const raw = SURFACE_CLASSES.map((c) => ({ c, v: (metres[c] / total) * 100 }));
  let left = 100;
  for (const r of raw) {
    out[r.c] = Math.floor(r.v);
    left -= out[r.c];
  }
  raw.sort((a, b) => (b.v % 1) - (a.v % 1));
  for (let i = 0; i < left; i++) out[raw[i % raw.length].c] += 1;
  return out;
}

/** Coloured stretches as GeoJSON for a MapLibre line layer (colour from the `cls` property). */
export function surfaceGeoJson(segments: SurfaceSegment[] | null | undefined): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (segments ?? [])
      .filter((s) => s.coords.length > 1)
      .map((s) => ({ type: "Feature", properties: { cls: s.cls }, geometry: { type: "LineString", coordinates: s.coords } })),
  };
}

/** MapLibre `line-color` expression for surfaceGeoJson features. */
export const SURFACE_COLOR_EXPR = [
  "match",
  ["get", "cls"],
  ...SURFACE_CLASSES.filter((c) => c !== "unknown").flatMap((c) => [c, SURFACE_COLOR[c]]),
  SURFACE_COLOR.unknown,
] as unknown as string;
