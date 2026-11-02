import { describe, expect, it } from "vitest";
import {
  cumulativeDistance,
  destination,
  elevationStats,
  interpolateAlong,
  joinSegments,
  lineLength,
  loopWaypoints,
  sampleIndices,
  segmentLength,
  simplify,
  type LngLat,
} from "@/lib/routes/geometry";
import { decodePolyline, encodePolyline } from "@/lib/routes/polyline";
import { generateLoop, RoutingError, ValhallaProvider, type RoutingProvider } from "@/lib/routes/routing";
import { gpxFileName, routeToGpx, toGpx } from "@/lib/routes/gpx";

const OSLO: LngLat = [10.7522, 59.9139];

describe("geometry", () => {
  it("destination and segmentLength agree", () => {
    for (const b of [0, 45, 90, 200, 315]) {
      const p = destination(OSLO, b, 1234);
      expect(segmentLength(OSLO, p)).toBeCloseTo(1234, 0);
    }
  });

  it("cumulative distance ends at line length", () => {
    const line = [OSLO, destination(OSLO, 90, 500), destination(OSLO, 90, 1500)];
    const cum = cumulativeDistance(line);
    expect(cum[0]).toBe(0);
    expect(cum[2]).toBeCloseTo(lineLength(line), 6);
    expect(cum[2]).toBeCloseTo(1500, 0);
  });

  it("simplify drops collinear points but keeps corners", () => {
    const line: LngLat[] = [];
    for (let i = 0; i <= 100; i++) line.push(destination(OSLO, 90, i * 10));
    const corner = line[line.length - 1];
    for (let i = 1; i <= 50; i++) line.push(destination(corner, 0, i * 10));
    const s = simplify(line, 1);
    expect(s.length).toBeLessThanOrEqual(4);
    expect(s[0]).toEqual(line[0]);
    expect(s[s.length - 1]).toEqual(line[line.length - 1]);
    expect(lineLength(s)).toBeCloseTo(lineLength(line), -1);
  });

  it("joins segments without duplicating the joint", () => {
    const a: LngLat[] = [[0, 0], [1, 1]];
    const b: LngLat[] = [[1, 1], [2, 2]];
    expect(joinSegments([a, b])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("elevation stats ignore small noise", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 ? 1 : -1));
    expect(elevationStats(noisy).gainM).toBe(0);
    const hill = [100, 110, 120, 130, 120, 100];
    const s = elevationStats(hill);
    expect(s.gainM).toBe(30);
    expect(s.lossM).toBe(30);
    expect(s.maxM).toBe(130);
    expect(elevationStats([null, null]).minM).toBeNull();
  });

  it("samples and interpolates elevation along a line", () => {
    expect(sampleIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    const idx = sampleIndices(1001, 11);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(1000);
    expect(idx.length).toBe(11);
    const line = Array.from({ length: 11 }, (_, i) => destination(OSLO, 0, i * 100));
    const out = interpolateAlong(line, [0, 10], [0, 100]);
    expect(out[5]).toBeCloseTo(50, 3);
    expect(out[10]).toBe(100);
  });

  it("loop waypoints start and end at the start and sit on a circle", () => {
    const wps = loopWaypoints(OSLO, 10_000, 90, 3, 1.3);
    expect(wps).toHaveLength(5);
    expect(wps[0]).toEqual(OSLO);
    expect(wps[4]).toEqual(OSLO);
    const r = 10_000 / (2 * Math.PI * 1.3);
    const centre = destination(OSLO, 90, r);
    for (const p of wps.slice(1, 4)) expect(segmentLength(centre, p)).toBeCloseTo(r, -1);
    // polygon perimeter is a bit under the circle circumference
    expect(lineLength(wps)).toBeGreaterThan(2 * Math.PI * r * 0.85);
  });
});

describe("polyline", () => {
  it("round-trips precision 6", () => {
    const pts: LngLat[] = [OSLO, [10.75, 59.92], [-122.4194, 37.7749]];
    const back = decodePolyline(encodePolyline(pts, 6), 6);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(pts[i][0], 6);
      expect(p[1]).toBeCloseTo(pts[i][1], 6);
    });
  });
  it("decodes the reference precision-5 example", () => {
    // Google's documented example
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    expect(pts).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });
});

/** Router that "routes" with straight lines, inflated by a fixed detour factor. */
function fakeRouter(detour: number, failFirst = 0): RoutingProvider & { calls: number } {
  let fails = failFirst;
  return {
    name: "fake",
    calls: 0,
    async route(wps) {
      this.calls++;
      if (fails-- > 0) throw new RoutingError("no", "no_route");
      const legs = wps.slice(1).map((p, i) => [wps[i], p]);
      return { legs, distanceM: lineLength(wps) * detour };
    },
    async elevation(points) {
      return points.map(() => 100);
    },
  };
}

describe("generateLoop", () => {
  it("converges on the target distance when streets meander more than expected", async () => {
    const r = fakeRouter(1.6);
    const res = await generateLoop(r, OSLO, 8000, 30);
    expect(Math.abs(res.distanceM - 8000) / 8000).toBeLessThan(0.06);
    expect(res.waypoints[0]).toEqual(OSLO);
    expect(res.legs).toHaveLength(4);
    expect(res.attempts).toBeGreaterThan(1);
  });

  it("rotates the loop when a waypoint is unroutable", async () => {
    const r = fakeRouter(1.3, 1);
    const res = await generateLoop(r, OSLO, 5000, 0);
    expect(res.distanceM).toBeGreaterThan(4000);
    expect(r.calls).toBeGreaterThanOrEqual(2);
  });

  it("throws when nothing can be routed", async () => {
    await expect(generateLoop(fakeRouter(1.3, 99), OSLO, 5000, 0)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("ValhallaProvider", () => {
  const leg1: LngLat[] = [OSLO, [10.76, 59.915]];
  const leg2: LngLat[] = [[10.76, 59.915], [10.77, 59.92]];
  it("sends pedestrian costing and decodes legs", async () => {
    let body: { locations: { lat: number; lon: number }[]; costing: string } | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ trip: { legs: [{ shape: encodePolyline(leg1), summary: { length: 0.6 } }, { shape: encodePolyline(leg2), summary: { length: 0.7 } }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new ValhallaProvider("https://example.test", fake);
    const res = await p.route([OSLO, [10.76, 59.915], [10.77, 59.92]]);
    expect(body!.costing).toBe("pedestrian");
    expect(body!.locations[0]).toMatchObject({ lat: OSLO[1], lon: OSLO[0] });
    expect(res.legs).toHaveLength(2);
    expect(res.distanceM).toBeCloseTo(1300, 6);
    expect(res.legs[1][0]).toEqual(res.legs[0][res.legs[0].length - 1]);
  });

  it("maps 'no path' errors to no_route and 5xx to unavailable", async () => {
    const mk = (status: number, json: unknown) => new ValhallaProvider("https://x", (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch);
    await expect(mk(400, { error_code: 171, error: "No suitable edges" }).route([OSLO, OSLO])).rejects.toMatchObject({ kind: "no_route" });
    await expect(mk(503, {}).route([OSLO, OSLO])).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("treats missing DEM values as null", async () => {
    const p = new ValhallaProvider("https://x", (async () => new Response(JSON.stringify({ height: [12, -32768, null] }), { status: 200 })) as unknown as typeof fetch);
    expect(await p.elevation([OSLO, OSLO, OSLO])).toEqual([12, null, null]);
  });
});

describe("gpx", () => {
  it("writes a valid track with escaped names and elevation", () => {
    const xml = routeToGpx(`Sognsvann <loop> & "back"`, [OSLO, [10.76, 59.92]], [100.04, null]);
    expect(xml).toContain(`<name>Sognsvann &lt;loop&gt; &amp; &quot;back&quot;</name>`);
    expect(xml).toContain(`<trkpt lat="59.9139" lon="10.7522"><ele>100</ele></trkpt>`);
    expect(xml).toContain(`<trkpt lat="59.92" lon="10.76"></trkpt>`);
    expect(xml.match(/<trkpt/g)).toHaveLength(2);
    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
  });

  it("includes time, heart rate and per-leg cadence for activities", () => {
    const xml = toGpx({ name: "Run", points: [{ lng: 10, lat: 60, ele: 5, time: new Date("2026-11-01T07:00:00Z"), hr: 150.4, cad: 172 }] });
    expect(xml).toContain("<time>2026-11-01T07:00:00.000Z</time>");
    expect(xml).toContain("<gpxtpx:hr>150</gpxtpx:hr><gpxtpx:cad>86</gpxtpx:cad>");
    expect(xml).toContain("xmlns:gpxtpx");
  });

  it("makes safe file names", () => {
    expect(gpxFileName("Løype rundt Sognsvann!")).toBe("loype-rundt-sognsvann.gpx");
    expect(gpxFileName("***")).toBe("route.gpx");
  });
});
