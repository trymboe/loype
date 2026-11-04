import { describe, expect, it } from "vitest";
import { addDaysIso } from "@/lib/dates";
import { wellnessSignals, type WellnessPoint } from "@/lib/planning/wellness-signals";

const today = "2026-11-02";
const days = (n: number, f: (i: number) => number, metric: string): WellnessPoint[] => Array.from({ length: n }, (_, i) => ({ date: addDaysIso(today, -(n - 1 - i)), metric, value: f(i) }));
// normal: HRV around 60 ms with day-to-day noise, RHR ~45, 7.5 h sleep
const noise = (i: number) => [0, 3, -2, 4, -3, 1, -1, 2][i % 8];
const normal = [...days(50, (i) => 60 + noise(i), "hrv_overnight_avg"), ...days(50, (i) => 45 + noise(i) / 2, "resting_hr"), ...days(50, () => 27000, "sleep_seconds")];

describe("wellness recovery signals", () => {
  it("stays quiet when everything is in your normal range", () => {
    expect(wellnessSignals(normal, today)).toMatchObject({ score: 0, fired: [] });
  });

  it("flags a 7-day HRV average below your normal range on its own", () => {
    const low = normal.map((p) => (p.metric === "hrv_overnight_avg" && p.date > addDaysIso(today, -7) ? { ...p, value: 48 } : p));
    const s = wellnessSignals(low, today);
    expect(s.fired).toEqual(["hrv"]);
    expect(s.score).toBeGreaterThanOrEqual(2);
  });

  it("needs two weaker signals together", () => {
    const rhrHigh = normal.map((p) => (p.metric === "resting_hr" && p.date >= addDaysIso(today, -1) ? { ...p, value: 53 } : p));
    expect(wellnessSignals(rhrHigh, today).score).toBe(1);
    const both = rhrHigh.map((p) => (p.metric === "sleep_seconds" && p.date >= addDaysIso(today, -1) ? { ...p, value: 5 * 3600 } : p));
    const s = wellnessSignals(both, today);
    expect(s.fired.sort()).toEqual(["rhr", "sleep"]);
    expect(s.score).toBe(2);
  });

  it("skips metrics without enough history and never counts Body Battery alone", () => {
    const sparse = days(5, () => 30, "hrv_overnight_avg");
    expect(wellnessSignals(sparse, today).score).toBe(0);
    const bb = days(5, () => 25, "body_battery_high");
    expect(wellnessSignals(bb, today).score).toBe(0.5);
  });
});
