import { describe, expect, it } from "vitest";
import { buildChartSeries } from "@/lib/analytics/series";

describe("buildChartSeries", () => {
  const n = 600;
  const t = Array.from({ length: n }, (_, i) => i);
  // 4:00/km for 300 s, standing 60 s, 5:00/km after
  const distance: number[] = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) d += i <= 300 ? 1000 / 240 : i <= 360 ? 0 : 1000 / 300;
    distance.push(d);
  }
  const motion = Array.from({ length: n - 1 }, (_, k) => (k + 1 > 300 && k + 1 <= 360 ? "s" : "m")).join("");

  it("smooths pace and blanks it while stopped", () => {
    const pts = buildChartSeries({ t, distance, hr: null, cadence: null, altitude: null, lat: null, lng: null, motion_states: motion }, 10_000);
    expect(pts[100].pace).toBeCloseTo(240, -1);
    expect(pts[330].pace).toBeNull();
    expect(pts[500].pace).toBeCloseTo(300, -1);
  });

  it("downsamples to the requested number of points", () => {
    const pts = buildChartSeries({ t, distance, hr: null, cadence: null, altitude: null, lat: null, lng: null, motion_states: motion }, 100);
    expect(pts.length).toBeLessThanOrEqual(100);
    expect(pts[1].i).toBe(6);
  });
});
