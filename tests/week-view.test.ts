import { describe, expect, it } from "vitest";
import { weekViews } from "../src/lib/planning/week-view";
import type { PlanWeek } from "../src/lib/planning/types";

const wk = (index: number, start: string, phase: PlanWeek["phase"], targetMinutes: number): PlanWeek => ({ index, start, phase, targetMinutes, note: "" });

describe("weekViews", () => {
  it("follows the workouts as they are now, not the planner's targets", () => {
    const v = weekViews(
      [wk(0, "2026-11-16", "base", 110), wk(1, "2026-11-23", "recovery", 76), wk(2, "2026-11-30", "base", 120)],
      [
        { date: "2026-11-17", type: "easy", status: "completed", duration_s: 3000 },
        { date: "2026-11-19", type: "long", status: "completed", duration_s: 3000 },
        { date: "2026-11-20", type: "easy", status: "skipped", duration_s: 1800 },
        // the coach turned the recovery week back into a normal one
        { date: "2026-11-23", type: "strides", status: "planned", duration_s: 1380 },
        { date: "2026-11-26", type: "long", status: "planned", duration_s: 3000 },
        { date: "2026-11-28", type: "easy", status: "planned", duration_s: 1800 },
        { date: "2026-11-29", type: "rest", status: "planned", duration_s: 0 },
      ],
    );
    expect(v.map((w) => w.minutes)).toEqual([100, 103, 120]);
    expect(v[1].phase).toBe("base");
  });

  it("keeps a recovery week that is still lighter", () => {
    const v = weekViews(
      [wk(0, "2026-11-16", "build", 110), wk(1, "2026-11-23", "recovery", 76)],
      [
        { date: "2026-11-17", type: "easy", status: "planned", duration_s: 6600 },
        { date: "2026-11-24", type: "easy", status: "planned", duration_s: 4560 },
      ],
    );
    expect(v.map((w) => w.phase)).toEqual(["build", "recovery"]);
  });
});
