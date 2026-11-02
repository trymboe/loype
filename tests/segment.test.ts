import { describe, expect, it } from "vitest";
import type { ChartPoint } from "@/lib/analytics/series";
import { compareLaps, lapSeries, nearestIndex, summarizeSegment, workLaps, type LapLike } from "@/lib/analytics/segment";

/** 1 point per 10 s; 5:00/km (3.333 m/s) with a 60 s stop at 600–660 s. HR climbs 1 bpm/min. */
function series(): ChartPoint[] {
  const pts: ChartPoint[] = [];
  let d = 0;
  for (let i = 0; i <= 120; i++) {
    const t = i * 10;
    const stopped = t > 600 && t <= 660;
    if (i > 0 && !stopped) d += 33.333;
    pts.push({ i, t, d: d / 1000, pace: stopped ? null : 300, hr: 140 + t / 60, cad: stopped ? null : 170, alt: 100 + (t <= 300 ? t / 10 : 30), lat: 60, lng: 10 });
  }
  return pts;
}

describe("summarizeSegment", () => {
  const pts = series();
  it("excludes the stop from moving time and pace", () => {
    const s = summarizeSegment(pts, 0, 120)!;
    expect(s.elapsedS).toBe(1200);
    expect(s.movingS).toBe(1140);
    expect(s.distanceM).toBeCloseTo(114 * 33.333, 0);
    expect(s.paceSPerKm).toBeCloseTo(300, 0);
    expect(s.avgCadence).toBe(170);
  });
  it("accepts a reversed selection and reports elevation and HR drift", () => {
    const s = summarizeSegment(pts, 30, 0)!;
    expect(s.startIdx).toBe(0);
    expect(s.endIdx).toBe(30);
    expect(s.elevGainM).toBeCloseTo(30, 0);
    expect(s.elevLossM).toBe(0);
    expect(s.hrDriftBpm).toBeGreaterThan(3);
    expect(s.maxHr).toBe(145);
  });
  it("returns null for an empty selection and no pace for very short ones", () => {
    expect(summarizeSegment(pts, 5, 5)).toBeNull();
    expect(summarizeSegment(pts, 5, 6)!.paceSPerKm).toBeNull();
  });
  it("finds the nearest point by distance or time", () => {
    expect(nearestIndex(pts, "t", 404)).toBe(40);
    expect(nearestIndex(pts, "t", 99999)).toBe(120);
    expect(nearestIndex(pts, "d", 0)).toBe(0);
    expect(nearestIndex([], "d", 1)).toBe(-1);
  });
});

const lap = (index: number, pace: number, hr: number, intensity: string | null = null, dist = 1000): LapLike => ({
  index,
  startT: index * 300,
  endT: index * 300 + (pace * dist) / 1000,
  distanceM: dist,
  timerS: (pace * dist) / 1000,
  avgSpeed: 1000 / pace,
  avgHr: hr,
  maxHr: hr + 5,
  avgCadence: 175,
  intensity,
});

describe("compareLaps", () => {
  it("computes deltas against the first selected lap", () => {
    const c = compareLaps([lap(1, 240, 165), lap(3, 250, 170)])!;
    expect(c.reference).toBe(1);
    expect(c.rows[1].paceDelta).toBeCloseTo(10, 6);
    expect(c.rows[1].hrDelta).toBe(5);
    expect(c.consistency).toBeNull();
  });
  it("measures consistency and fade across reps", () => {
    const c = compareLaps([lap(1, 240, 165), lap(3, 242, 168), lap(5, 244, 171), lap(7, 252, 175), lap(9, 255, 178), lap(11, 258, 180)])!;
    expect(c.consistency).not.toBeNull();
    expect(c.consistency!.fadeSPerKm).toBeCloseTo((255 + 258) / 2 - (240 + 242) / 2, 6);
    expect(c.consistency!.hrRiseBpm).toBeCloseTo((178 + 180) / 2 - (165 + 168) / 2, 6);
    expect(c.consistency!.fastest).toBe(1);
    expect(c.consistency!.slowest).toBe(11);
    expect(c.consistency!.paceCvPct).toBeGreaterThan(1);
  });
  it("needs at least two laps", () => {
    expect(compareLaps([lap(0, 300, 150)])).toBeNull();
  });
});

describe("workLaps", () => {
  it("uses the watch's intensity tags when present", () => {
    const laps = [lap(0, 360, 140, "warmup"), lap(1, 240, 170, "active"), lap(2, 400, 150, "rest"), lap(3, 242, 172, "active"), lap(4, 380, 145, "cooldown")];
    expect(workLaps(laps)).toEqual([1, 3]);
  });
  it("falls back to laps clearly faster than the median", () => {
    const laps = [lap(0, 360, 140), lap(1, 240, 170), lap(2, 400, 150), lap(3, 242, 172), lap(4, 390, 150), lap(5, 245, 172), lap(6, 380, 145)];
    expect(workLaps(laps)).toEqual([1, 3, 5]);
  });
  it("returns nothing for an even-paced run", () => {
    expect(workLaps([lap(0, 300, 150), lap(1, 302, 151), lap(2, 299, 152)])).toEqual([]);
  });
});

describe("lapSeries", () => {
  it("re-bases x to metres from the lap start", () => {
    const pts = series();
    const s = lapSeries(pts, { startT: 100, endT: 200 });
    expect(s[0].x).toBe(0);
    expect(s[s.length - 1].x).toBeCloseTo(333.33, 1);
  });
});
