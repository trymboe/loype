import { describe, expect, it } from "vitest";
import { parseFitActivity } from "@/lib/fit/parse";
import { deriveActivity } from "@/lib/analytics/summarize";
import { buildFit } from "./fit-builder";

const easyRun = { durationS: 1800, speedMs: 3, hr: 145 };
const codes = (bytes: Uint8Array) => deriveActivity(parseFitActivity(bytes)).quality;

describe("assessQuality", () => {
  it("passes a clean outdoor run", () => {
    const q = codes(buildFit({ segments: [easyRun] }));
    expect(q.flags).toEqual([]);
    expect(q.usableForFitness).toBe(true);
    expect(q.score).toBe(1);
  });

  it("flags GPS spikes and marks pace unreliable (scenario 5: GPS-corrupted activity)", () => {
    const q = codes(buildFit({ segments: [easyRun], gpsSpikesAt: [100, 400, 700, 1000, 1300, 1600] }));
    expect(q.flags.map((f) => f.code)).toContain("gps_spikes");
    expect(q.paceReliable).toBe(false);
  });

  it("treats treadmill runs as indoor with unreliable pace", () => {
    const q = codes(buildFit({ segments: [easyRun], subSport: "treadmill", gps: false }));
    expect(q.flags.map((f) => f.code)).toContain("indoor");
    expect(q.paceReliable).toBe(false);
    expect(q.hrReliable).toBe(true);
    expect(q.usableForFitness).toBe(true);
  });

  it("detects heart rate locked to cadence", () => {
    const q = codes(buildFit({ segments: [easyRun], hrFollowsCadence: true }));
    expect(q.flags.map((f) => f.code)).toContain("hr_cadence_lock");
    expect(q.hrReliable).toBe(false);
  });

  it("flags missing heart rate", () => {
    const q = codes(buildFit({ segments: [easyRun], hrMissing: true }));
    expect(q.flags.map((f) => f.code)).toContain("hr_missing");
    expect(q.hrReliable).toBe(false);
  });

  it("excludes very short activities from fitness evidence", () => {
    const q = codes(buildFit({ segments: [{ durationS: 120, speedMs: 3, hr: 140 }] }));
    expect(q.flags.map((f) => f.code)).toContain("too_short");
    expect(q.usableForFitness).toBe(false);
  });
});
