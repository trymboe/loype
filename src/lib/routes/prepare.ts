import { elevationStats, isLngLat, lineLength, simplify, type LngLat } from "./geometry";

export interface RouteDraft {
  name: string;
  coords: LngLat[];
  elevations: (number | null)[] | null;
  waypoints: LngLat[];
  snapped: boolean[];
}

export interface PreparedRoute extends RouteDraft {
  distance_m: number;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
}

/**
 * Validates a route from the planner and derives its stored numbers. Distance and
 * elevation are always recomputed here rather than trusted from the browser.
 */
export function prepareRoute(d: RouteDraft): PreparedRoute | { error: string } {
  const name = d.name.trim().slice(0, 80);
  if (!name) return { error: "Give the route a name" };
  if (!Array.isArray(d.coords) || d.coords.length < 2 || !d.coords.every(isLngLat)) return { error: "Draw a route with at least two points first" };
  if (d.coords.length > 50_000) return { error: "That route is too long to save" };
  const hasEle = Array.isArray(d.elevations) && d.elevations.length === d.coords.length;
  // Simplify, keeping each kept point's elevation
  const kept = simplify(d.coords.map((c, i) => [c[0], c[1], i] as const), 2);
  const coords = kept.map(([lng, lat]) => [round(lng), round(lat)] as LngLat);
  const elevations = hasEle ? kept.map(([, , i]) => (typeof d.elevations![i] === "number" ? Math.round(d.elevations![i]! * 10) / 10 : null)) : null;
  const distance = lineLength(coords);
  if (distance < 50) return { error: "The route is shorter than 50 m" };
  const ele = elevations && elevations.some((e) => e != null) ? elevationStats(elevations) : null;
  return {
    name,
    coords,
    elevations,
    waypoints: (d.waypoints ?? []).filter(isLngLat).slice(0, 200).map(([a, b]) => [round(a), round(b)]),
    snapped: (d.snapped ?? []).slice(0, 199).map(Boolean),
    distance_m: distance,
    elevation_gain_m: ele ? Math.round(ele.gainM) : null,
    elevation_loss_m: ele ? Math.round(ele.lossM) : null,
  };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
