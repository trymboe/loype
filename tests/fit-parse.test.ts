import { describe, expect, it } from "vitest";
import { parseFitActivity, FitParseError } from "@/lib/fit/parse";
import { deriveActivity } from "@/lib/analytics/summarize";
import { buildFit } from "./fit-builder";

describe("parseFitActivity", () => {
  it("decodes a synthetic run with streams, laps, timer events and UTC offset", () => {
    const bytes = buildFit({
      segments: [
        { durationS: 600, speedMs: 3, hr: 140 },
        { durationS: 60, speedMs: 0, hr: 120, paused: true },
        { durationS: 600, speedMs: 3.5, hr: 155 },
      ],
    });
    const a = parseFitActivity(bytes);
    expect(a.sport).toBe("running");
    expect(a.startTime.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(a.utcOffsetS).toBe(3600);
    expect(a.streams.t.length).toBe(1200);
    expect(a.streams.t[0]).toBe(1);
    expect(a.streams.cadence[10]).toBe(170); // strides doubled to steps/min
    expect(a.streams.lat[0]).toBeCloseTo(59.914, 3);
    expect(a.totals.distanceM).toBeCloseTo(600 * 3 + 600 * 3.5, 0);
    expect(a.totals.elapsedS).toBe(1260);
    expect(a.totals.timerS).toBe(1200);
    expect(a.laps.length).toBe(4); // 3.9 km → 3 full + 1 partial
    expect(a.timerEvents.map((e) => e.type)).toEqual(["start", "stop", "start", "stop"]);
  });

  it("rejects non-FIT bytes", () => {
    expect(() => parseFitActivity(new TextEncoder().encode("hello world, not a fit file"))).toThrow(FitParseError);
  });
});

describe("deriveActivity", () => {
  it("excludes paused and standing time from moving time", () => {
    const a = parseFitActivity(
      buildFit({
        segments: [
          { durationS: 600, speedMs: 3, hr: 140 },
          { durationS: 120, speedMs: 0, hr: 110 }, // standing at a light, timer running
          { durationS: 300, speedMs: 0, hr: 100, paused: true },
          { durationS: 600, speedMs: 3, hr: 145 },
        ],
      }),
    );
    const d = deriveActivity(a);
    expect(d.motion.movingS).toBeCloseTo(1200, -1);
    expect(d.motion.stoppedS).toBeCloseTo(120, -1);
    expect(d.motion.pausedS).toBeCloseTo(300, -1);
    expect(d.summary.avgSpeedMoving).toBeCloseTo(3, 1);
  });

  it("computes per-km splits with interpolated boundaries", () => {
    // 2.5 km: first 1.5 km at 4:00/km, then 1 km at 5:00/km
    const a = parseFitActivity(
      buildFit({
        segments: [
          { durationS: 360, speedMs: 1000 / 240, hr: 160 },
          { durationS: 300, speedMs: 1000 / 300, hr: 150 },
        ],
      }),
    );
    const { splits } = deriveActivity(a);
    expect(splits.length).toBe(3);
    expect(splits[0].paceSecPerKm).toBeCloseTo(240, 0);
    expect(splits[1].paceSecPerKm).toBeCloseTo(270, 0); // half at 4:00, half at 5:00
    expect(splits[2].partial).toBe(true);
    expect(splits[2].distanceM).toBeCloseTo(500, 0);
    expect(splits[2].paceSecPerKm).toBeCloseTo(300, 0);
    expect(splits[0].avgHr).toBeCloseTo(160, 0);
  });

  it("reports elevation gain with hysteresis", () => {
    const a = parseFitActivity(
      buildFit({ segments: [{ durationS: 300, speedMs: 3, hr: 150, climbMPerS: 0.1 }, { durationS: 300, speedMs: 3, hr: 150, climbMPerS: -0.1 }] }),
    );
    const { summary } = deriveActivity(a);
    expect(summary.elevationGainM).toBeGreaterThan(25);
    expect(summary.elevationGainM).toBeLessThan(31);
    expect(summary.provenance.elevationGain).toBe("calculated");
    expect(summary.provenance.distance).toBe("device");
  });
});
