/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { Decoder, Stream } from "@garmin/fitsdk";
import { encodeWorkoutFit, fitFileName, workoutStepMessages } from "../src/lib/fit/workout-encode";
import { buildIntervalsEvent, checkParsed, chooseTargetMode, encodeWorkoutText, externalIdFor, formatDistanceToken, formatDurationToken } from "../src/lib/integrations/intervals/encode";
import { parseAthlete } from "../src/lib/integrations/intervals/client";
import type { Step, Target } from "../src/lib/planning/types";

const T = (zone: Target["zone"], pace: [number, number] | null, hr: [number, number] | null): Target => ({
  zone,
  paceFast: pace?.[0] ?? null,
  paceSlow: pace?.[1] ?? null,
  hrMin: hr?.[0] ?? null,
  hrMax: hr?.[1] ?? null,
  label: zone,
});
const easy = T("easy", [330, 376], [125, 145]);
const thr = T("threshold", [290, 302], [165, 175]);
const rec = T("recovery", [376, 406], [110, 125]);

const threshold: Step[] = [
  { kind: "warmup", durationS: 900, target: easy },
  { kind: "repeat", count: 4, steps: [{ kind: "run", durationS: 360, target: thr }, { kind: "recover", durationS: 90, target: rec, note: "easy jog" }] },
  { kind: "cooldown", durationS: 600, target: easy },
];
const athlete = { hasThresholdPace: true, maxHr: 190 };

describe("Intervals.icu workout text", () => {
  it("formats durations and distances in Intervals.icu units (m = minutes, mtr = metres)", () => {
    expect(formatDurationToken(600)).toBe("10m");
    expect(formatDurationToken(90)).toBe("1m30s");
    expect(formatDurationToken(30)).toBe("30s");
    expect(formatDurationToken(3900)).toBe("1h5m");
    expect(formatDistanceToken(1000)).toBe("1km");
    expect(formatDistanceToken(1500)).toBe("1.5km");
    expect(formatDistanceToken(400)).toBe("400mtr");
  });

  it("encodes warm-up, repeats with recoveries, and cool-down with absolute pace ranges", () => {
    const text = encodeWorkoutText(threshold, "PACE", athlete);
    expect(text).toBe(
      ["Warmup", "- Warm up 15m 5:30-6:16/km Pace", "", "4x", "- Threshold 6m 4:50-5:02/km Pace", "- Recover 1m30s 6:16-6:46/km Pace", "", "Cooldown", "- Cool down 10m 5:30-6:16/km Pace"].join("\n"),
    );
  });

  it("uses % of Intervals.icu's max HR when pace targets can't reach Garmin", () => {
    expect(chooseTargetMode(threshold, { hasThresholdPace: false, maxHr: 190 })).toBe("HR");
    const text = encodeWorkoutText(threshold, "HR", athlete);
    expect(text).toContain("- Threshold 6m 87-92% HR");
    expect(text).not.toContain("Pace");
  });

  it("falls back to cue-only steps without pace or HR data", () => {
    const steps: Step[] = [{ kind: "run", durationS: 1800, target: T("easy", null, null) }];
    expect(chooseTargetMode(steps, { hasThresholdPace: true, maxHr: 190 })).toBe("NONE");
    expect(encodeWorkoutText(steps, "NONE", athlete)).toBe("- Easy 30m");
  });

  it("handles distance steps and hill reps without a pace (no target on those steps)", () => {
    const steps: Step[] = [
      { kind: "warmup", durationS: 600, target: easy },
      { kind: "repeat", count: 6, steps: [{ kind: "run", durationS: 60, target: T("hill", null, null) }, { kind: "recover", durationS: 90, target: rec }] },
      { kind: "run", distanceM: 400, target: thr },
    ];
    expect(chooseTargetMode(steps, athlete)).toBe("PACE");
    const text = encodeWorkoutText(steps, "PACE", athlete);
    expect(text).toContain("- Hill 1m\n");
    expect(text).toContain("- Threshold 400mtr 4:50-5:02/km Pace");
  });

  it("unrolls nested repeats, which Intervals.icu doesn't support", () => {
    const steps: Step[] = [{ kind: "repeat", count: 2, steps: [{ kind: "repeat", count: 3, steps: [{ kind: "run", durationS: 60, target: thr }] }, { kind: "recover", durationS: 180, target: rec }] }];
    const text = encodeWorkoutText(steps, "PACE", athlete);
    expect(text.split("\n").filter((l) => l.startsWith("- Threshold")).length).toBe(3);
    expect(text.startsWith("2x\n")).toBe(true);
  });

  it("builds a stable, idempotent event with an external id and a content hash", () => {
    const w = { id: "abc", date: "2026-11-05", title: "Threshold intervals", objective: "x", steps: threshold, durationS: 3300 };
    const a = buildIntervalsEvent(w, athlete);
    const b = buildIntervalsEvent(w, athlete);
    expect(a.hash).toBe(b.hash);
    expect(a.event).toMatchObject({ category: "WORKOUT", type: "Run", start_date_local: "2026-11-05T00:00:00", external_id: externalIdFor("abc"), target: "PACE", moving_time: 3300 });
    const moved = buildIntervalsEvent({ ...w, date: "2026-11-06" }, athlete);
    expect(moved.hash).not.toBe(a.hash);
    expect(moved.event.external_id).toBe(a.event.external_id);
  });

  it("checks Intervals.icu's parsed workout against what was sent", () => {
    const doc = {
      steps: [
        { duration: 900, pace: { start: 330, end: 376, units: "secs/km" } },
        { reps: 4, steps: [{ duration: 360, pace: { start: 290, end: 302 } }, { duration: 90, pace: { start: 376, end: 406 } }] },
        { duration: 600, pace: { start: 330, end: 376 } },
      ],
    };
    expect(checkParsed(threshold, "PACE", athlete, doc).ok).toBe(true);
    const lost = { steps: [doc.steps[0], { reps: 4, steps: [{ duration: 360 }, { duration: 90 }] }, doc.steps[2]] };
    const bad = checkParsed(threshold, "PACE", athlete, lost);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/2 of 10 targets/);
    expect(checkParsed(threshold, "PACE", athlete, null).ok).toBe(false);
  });

  it("reads Run threshold pace and max HR from the athlete record", () => {
    const a = parseAthlete({ id: "i123", name: "T", sportSettings: [{ types: ["Ride"], max_hr: 180 }, { types: ["Run", "TrailRun"], threshold_pace: 3.4483, max_hr: 192 }] });
    expect(a.run).toEqual({ hasThresholdPace: true, thresholdPaceSPerKm: 290, maxHr: 192 });
    expect(parseAthlete({ id: 1, sportSettings: [] }).run.hasThresholdPace).toBe(false);
  });
});

describe("FIT workout export", () => {
  it("encodes steps with repeat back-references and per-step targets", () => {
    const msgs = workoutStepMessages(threshold);
    expect(msgs.map((m) => m.durationType)).toEqual(["time", "time", "time", "repeatUntilStepsCmplt", "time"]);
    expect(msgs[3]).toMatchObject({ durationValue: 1, targetValue: 4 });
    expect(msgs[1]).toMatchObject({ targetType: "speed", customTargetValueLow: Math.round((1000 / 302) * 1000), customTargetValueHigh: Math.round((1000 / 290) * 1000) });
  });

  it("writes a valid FIT workout file that Garmin's decoder reads back", () => {
    const bytes = encodeWorkoutFit({ title: "Løype terskel 4×6 min", steps: [...threshold, { kind: "run", distanceM: 1000, target: T("easy", null, [120, 140]) }] });
    const decoder = new Decoder(Stream.fromByteArray(bytes));
    expect(decoder.isFIT()).toBe(true);
    expect(decoder.checkIntegrity()).toBe(true);
    const { messages, errors } = decoder.read();
    expect(errors).toEqual([]);
    expect(messages.fileIdMesgs![0].type).toBe("workout");
    expect(messages.workoutMesgs![0]).toMatchObject({ sport: "running", numValidSteps: 6, wktName: "Loype terskel 4x6 min" });
    const steps = messages.workoutStepMesgs as any[];
    expect(steps[0]).toMatchObject({ durationType: "time", durationTime: 900, targetType: "speed", intensity: "warmup" });
    expect(steps[0].customTargetSpeedLow).toBeCloseTo(1000 / 376, 2);
    expect(steps[3]).toMatchObject({ durationType: "repeatUntilStepsCmplt", durationStep: 1, repeatSteps: 4 });
    expect(steps[5]).toMatchObject({ durationType: "distance", durationDistance: 1000, targetType: "heartRate", customTargetHeartRateLow: 220, customTargetHeartRateHigh: 240 });
  });

  it("names files safely", () => {
    expect(fitFileName("2026-11-05", "Løype: Threshold 4×6")).toBe("loype-2026-11-05-loype-threshold-4x6.fit");
  });
});
