/**
 * "Open in Google Maps" links. Google Maps URLs take an origin, a destination
 * and at most 9 waypoints (fewer in some mobile browsers), and Google routes
 * between them itself, so we pin the route down with via points spread evenly
 * by distance along it. Between close via points Google rarely has room to
 * take a different path.
 */
import { cumulativeDistance, segmentLength, type LngLat } from "./geometry";

export const GMAPS_MAX_WAYPOINTS = 8;

const fmt = ([lng, lat]: LngLat) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

/** Indices of `n` via points spread along the line (excluding the ends). */
export function viaIndices(coords: LngLat[], n = GMAPS_MAX_WAYPOINTS): number[] {
  if (coords.length < 3 || n <= 0) return [];
  const cum = cumulativeDistance(coords);
  const total = cum[cum.length - 1];
  if (total <= 0) return [];
  const out: number[] = [];
  let j = 1;
  for (let k = 1; k <= n; k++) {
    const target = (total * k) / (n + 1);
    while (j < coords.length - 2 && cum[j] < target) j++;
    const i = Math.abs(cum[j - 1] - target) < Math.abs(cum[j] - target) && j - 1 > 0 ? j - 1 : j;
    if (i > 0 && i < coords.length - 1 && i !== out[out.length - 1]) out.push(i);
  }
  return out;
}

/** A walking-directions link that opens the Google Maps app on phones (universal link). */
export function googleMapsUrl(coords: LngLat[], maxWaypoints = GMAPS_MAX_WAYPOINTS): string | null {
  if (coords.length < 2) return null;
  const origin = coords[0];
  const dest = coords[coords.length - 1];
  const via = viaIndices(coords, maxWaypoints).map((i) => coords[i]);
  // Drop via points that sit on top of the ends (out-and-backs, tiny loops).
  const useful = via.filter((p) => segmentLength(p, origin) > 30 && segmentLength(p, dest) > 30);
  const q = new URLSearchParams({ api: "1", origin: fmt(origin), destination: fmt(dest), travelmode: "walking" });
  if (useful.length) q.set("waypoints", useful.map(fmt).join("|"));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
