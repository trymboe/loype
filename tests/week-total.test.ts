import { describe, expect, it } from "vitest";
import { plannedMinutes } from "@/lib/planning/week-total";

describe("plan week total", () => {
  it("leaves out skipped and missed sessions", () => {
    // Trym's week of 16 Nov: a missed 33 min run, then 34 + 26 + 50 min done
    const week = [
      { status: "missed", duration_s: 33 * 60 },
      { status: "completed", duration_s: 34 * 60 },
      { status: "completed", duration_s: 26 * 60 },
      { status: "skipped", duration_s: 23 * 60 },
      { status: "planned", duration_s: 50 * 60 },
    ];
    expect(plannedMinutes(week)).toBe(110);
  });
});
