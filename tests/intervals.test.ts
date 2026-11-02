import { describe, expect, it } from "vitest";
import { trainingPaces } from "@/lib/analytics/fitness/vdot";
import { analyzeIntervals, type LapLike, type StreamLike } from "@/lib/planning/intervals";
import { buildWorkout, type TargetContext } from "@/lib/planning/workouts";
import type { Baseline } from "@/lib/planning/types";

const ctx: TargetContext = { baseline: { paceZones: trainingPaces(41.5), hrZones: null } as unknown as Baseline, racePace: null, raceLabel: null };
const w = buildWorkout({ type: "vo2max", progress: 0 }, ctx); // 4 × 3 min
const iz = trainingPaces(41.5).find((z) => z.key === "interval")!;
const targetSpeed = 1000 / ((iz.fastSPerKm + iz.slowSPerKm) / 2);

function session(repSpeeds: number[], hrrs: number[] = repSpeeds.map(() => 30)): { stream: StreamLike; laps: LapLike[] } {
  const t: number[] = [];
  const speed: number[] = [];
  const hr: number[] = [];
  const laps: LapLike[] = [];
  let s = 0;
  const seg = (dur: number, v: number, h: (i: number) => number) => {
    laps.push({ start_offset_s: s, timer_s: dur, elapsed_s: dur, distance_m: dur * v, avg_speed: v, avg_hr: null, max_hr: null });
    for (let i = 0; i < dur; i++) {
      t.push(s);
      speed.push(v + (i % 7 === 0 ? 0.15 : i % 5 === 0 ? -0.15 : 0));
      hr.push(h(i));
      s++;
    }
  };
  seg(900, 2.7, () => 135);
  repSpeeds.forEach((v, k) => {
    seg(180, v, (i) => Math.min(180, 150 + i / 6 + k * 2));
    seg(135, 2.4, (i) => Math.max(120, 180 + k * 2 - Math.min(i, 60) * (hrrs[k] / 60)));
  });
  seg(600, 2.7, () => 135);
  let d = 0;
  const distance = t.map((_, i) => (d += i ? speed[i] : 0));
  return { stream: { t, speed, hr, distance }, laps };
}

describe("interval analysis", () => {
  it("finds every rep from the stream and reads even, on-target pacing", () => {
    const { stream } = session([targetSpeed, targetSpeed, targetSpeed, targetSpeed]);
    const a = analyzeIntervals(w.steps, stream)!;
    expect(a.source).toBe("stream");
    expect(a.found).toBe(4);
    expect(a.reps.every((r) => Math.abs(r.durationS - 180) <= 15)).toBe(true);
    expect(a.reps.every((r) => r.onTarget)).toBe(true);
    expect(Math.abs(a.fadePct)).toBeLessThan(2);
    expect(a.notes.join(" ")).toMatch(/4 of 4 reps on target/);
  });

  it("uses the watch laps when they match the plan, and spots a fade and slower HR recovery", () => {
    const { stream, laps } = session([targetSpeed * 1.06, targetSpeed, targetSpeed * 0.95, targetSpeed * 0.92], [32, 28, 22, 16]);
    const a = analyzeIntervals(w.steps, stream, laps)!;
    expect(a.source).toBe("laps");
    expect(a.found).toBe(4);
    expect(a.fadePct).toBeGreaterThan(5);
    expect(a.notes.join(" ")).toMatch(/slower than the first, after a first rep faster than target/);
    expect(a.hrrFirst! - a.hrrLast!).toBeGreaterThan(10);
    expect(a.notes.join(" ")).toMatch(/recovered less between later reps/);
  });

  it("reports nothing for a steady run or a session without a repeat", () => {
    const steady: StreamLike = { t: Array.from({ length: 3000 }, (_, i) => i), speed: Array(3000).fill(3), hr: Array(3000).fill(140), distance: null };
    expect(analyzeIntervals(w.steps, steady)).toBeNull();
    expect(analyzeIntervals(buildWorkout({ type: "easy", minutes: 40 }, ctx).steps, session([4, 4]).stream)).toBeNull();
  });
});
