import { describe, expect, it } from "vitest";
import { formatDuration, formatPace, speedToPaceSecPerKm } from "@/lib/units";
import { isLikelyDuplicate } from "@/lib/analytics/dedupe";

describe("units", () => {
  it("formats pace and durations", () => {
    expect(formatPace(280)).toBe("4:40");
    expect(formatPace(299.7)).toBe("5:00");
    expect(speedToPaceSecPerKm(1000 / 280)).toBeCloseTo(280);
    expect(speedToPaceSecPerKm(0)).toBeNull();
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(65)).toBe("1:05");
  });
});

describe("isLikelyDuplicate", () => {
  const base = { startTime: new Date("2026-10-01T06:00:00Z"), elapsedS: 3000, distanceM: 10000 };
  it("matches the same run from two sources", () => {
    expect(isLikelyDuplicate(base, { startTime: new Date("2026-10-01T06:00:40Z"), elapsedS: 2990, distanceM: 10050 })).toBe(true);
  });
  it("does not match a different run the same day", () => {
    expect(isLikelyDuplicate(base, { startTime: new Date("2026-10-01T17:00:00Z"), elapsedS: 3000, distanceM: 10000 })).toBe(false);
    expect(isLikelyDuplicate(base, { startTime: new Date("2026-10-01T06:01:00Z"), elapsedS: 1200, distanceM: 4000 })).toBe(false);
  });
});
