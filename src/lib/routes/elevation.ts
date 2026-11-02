import { interpolateAlong, sampleIndices, type LngLat } from "./geometry";
import type { RoutingProvider } from "./routing";

/** Max points sent to the elevation service per request; the rest are interpolated by distance. */
export const ELEVATION_SAMPLES = 300;

/** Elevation for every coordinate, from at most ELEVATION_SAMPLES looked-up points. */
export async function elevationAlong(router: RoutingProvider, coords: LngLat[]): Promise<(number | null)[]> {
  if (coords.length === 0) return [];
  const idx = sampleIndices(coords.length, ELEVATION_SAMPLES);
  const sampled = await router.elevation(idx.map((i) => coords[i]));
  return interpolateAlong(coords, idx, sampled);
}
