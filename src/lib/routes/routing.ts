/**
 * Routing for the route planner, behind a small interface so the provider can
 * change. The default is Valhalla (OSM data, pedestrian costing tuned for
 * running: paths, tracks and footways are fine, ferries and driveways are not).
 * The FOSSGIS community server needs no key; set ROUTING_VALHALLA_URL to use
 * another Valhalla instance.
 */
import { lineLength, loopWaypoints, type LngLat } from "./geometry";
import { decodePolyline, encodePolyline } from "./polyline";
import { summarizeSurfaces, type SurfaceEdge, type SurfaceSummary } from "./surface";

export interface RoutedPath {
  /** One coordinate list per pair of consecutive waypoints. */
  legs: LngLat[][];
  distanceM: number;
}

export interface RoutingProvider {
  readonly name: string;
  route(waypoints: LngLat[]): Promise<RoutedPath>;
  /** Elevation in metres for each point (null where the model has no data). */
  elevation(points: LngLat[]): Promise<(number | null)[]>;
  /** Snaps a line to the path network and reports the surface along it. `gps` loosens matching for recorded tracks. */
  surfaces(points: LngLat[], opts?: { gps?: boolean }): Promise<SurfaceSummary>;
}

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly kind: "no_route" | "unavailable" | "bad_request",
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export const DEFAULT_VALHALLA_URL = "https://valhalla1.openstreetmap.de";

export const RUNNING_COSTING = {
  // 0–1 preferences; 0.5 is neutral. Runners like trails and quiet streets.
  use_tracks: 0.7,
  use_living_streets: 0.7,
  use_hills: 0.5,
  use_ferry: 0,
  walkway_factor: 0.9,
  sidewalk_factor: 0.95,
  alley_factor: 2,
  driveway_factor: 5,
};

export class ValhallaProvider implements RoutingProvider {
  readonly name = "Valhalla (OpenStreetMap)";
  constructor(
    private readonly baseUrl = DEFAULT_VALHALLA_URL,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Loype/1.0 (private single-user running app)" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RoutingError("The routing service didn't respond. Try again in a moment.", "unavailable");
    }
    const json = (await res.json().catch(() => null)) as { error?: string; error_code?: number } | null;
    if (!res.ok) {
      // Valhalla 1xx/4xx codes: 171 = no road near a point, 442/443 = no path between points, 444 = map matching failed
      const code = json?.error_code;
      if (res.status === 400 && code != null && [170, 171, 172, 442, 443, 444].includes(code)) {
        throw new RoutingError("No runnable path found there. Move the point closer to a road or trail.", "no_route");
      }
      if (res.status === 400) throw new RoutingError(json?.error ?? "The routing request was rejected.", "bad_request");
      throw new RoutingError("The routing service is unavailable right now. Try again shortly.", "unavailable");
    }
    return json;
  }

  async route(waypoints: LngLat[]): Promise<RoutedPath> {
    if (waypoints.length < 2) return { legs: [], distanceM: 0 };
    const json = (await this.post("/route", {
      locations: waypoints.map(([lon, lat]) => ({ lat, lon, type: "break" })),
      costing: "pedestrian",
      costing_options: { pedestrian: RUNNING_COSTING },
      directions_type: "none",
      units: "kilometers",
    })) as { trip?: { legs?: { shape: string; summary?: { length?: number } }[] } };
    const legs = json.trip?.legs;
    if (!legs || legs.length !== waypoints.length - 1) throw new RoutingError("Unexpected answer from the routing service.", "unavailable");
    const coords = legs.map((l) => decodePolyline(l.shape, 6));
    // Snap the ends to the requested waypoints' snapped positions so legs join exactly.
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      if (prev.length && coords[i].length) coords[i][0] = prev[prev.length - 1];
    }
    const distanceM = legs.reduce((s, l, i) => s + (l.summary?.length != null ? l.summary.length * 1000 : lineLength(coords[i])), 0);
    return { legs: coords, distanceM };
  }

  async elevation(points: LngLat[]): Promise<(number | null)[]> {
    if (!points.length) return [];
    const json = (await this.post("/height", { range: false, shape: points.map(([lon, lat]) => ({ lat, lon })) })) as { height?: (number | null)[] };
    const h = json.height ?? [];
    // Valhalla reports missing DEM tiles as -32768
    return points.map((_, i) => (h[i] != null && h[i]! > -1000 ? h[i]! : null));
  }

  async surfaces(points: LngLat[], { gps = false }: { gps?: boolean } = {}): Promise<SurfaceSummary> {
    if (points.length < 2) return summarizeSurfaces([], []);
    const json = (await this.post("/trace_attributes", {
      encoded_polyline: encodePolyline(points, 6),
      shape_match: "map_snap",
      costing: "pedestrian",
      costing_options: { pedestrian: RUNNING_COSTING },
      // Planned routes already follow paths; GPS tracks wander a few metres.
      trace_options: { search_radius: gps ? 35 : 15, gps_accuracy: gps ? 10 : 5 },
      filters: {
        attributes: ["edge.surface", "edge.length", "edge.begin_shape_index", "edge.end_shape_index", "shape"],
        action: "include",
      },
    })) as { shape?: string; edges?: SurfaceEdge[] };
    if (!json.edges) throw new RoutingError("Unexpected answer from the routing service.", "unavailable");
    return summarizeSurfaces(json.shape ? decodePolyline(json.shape, 6) : [], json.edges);
  }
}

export function routingProvider(): RoutingProvider {
  return new ValhallaProvider(process.env.ROUTING_VALHALLA_URL || DEFAULT_VALHALLA_URL);
}

export interface LoopResult extends RoutedPath {
  waypoints: LngLat[];
  attempts: number;
}

/**
 * Generates a loop of roughly `targetM` starting and ending at `start`.
 * Routes through circle waypoints, then rescales the circle from the routed
 * length (streets meander) until it is within `tolerance` or attempts run out.
 * If a waypoint lands somewhere unroutable (lake, private land) the circle is
 * rotated and tried again.
 */
export async function generateLoop(
  router: RoutingProvider,
  start: LngLat,
  targetM: number,
  bearingDeg: number,
  { maxAttempts = 4, tolerance = 0.06, points = 3 }: { maxAttempts?: number; tolerance?: number; points?: number } = {},
): Promise<LoopResult> {
  let scale = 1;
  let bearing = bearingDeg;
  let best: LoopResult | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wps = loopWaypoints(start, targetM * scale, bearing, points);
    let res: RoutedPath;
    try {
      res = await router.route(wps);
    } catch (e) {
      lastError = e;
      if (e instanceof RoutingError && e.kind === "no_route") {
        bearing = (bearing + 47) % 360;
        continue;
      }
      throw e;
    }
    const cand: LoopResult = { ...res, waypoints: wps, attempts: attempt };
    if (!best || Math.abs(res.distanceM - targetM) < Math.abs(best.distanceM - targetM)) best = cand;
    const ratio = res.distanceM / targetM;
    if (Math.abs(ratio - 1) <= tolerance || res.distanceM <= 0) break;
    scale = Math.min(3, Math.max(0.2, scale / ratio));
  }
  if (!best) throw lastError instanceof Error ? lastError : new RoutingError("Couldn't find a loop from here.", "no_route");
  return best;
}
