import { describe, expect, it } from "vitest";
import { trainingPaces } from "@/lib/analytics/fitness/vdot";
import { editIssues, editableSteps, rebuildSteps, titleFor, toEditable } from "@/lib/planning/edit-steps";
import { buildWorkout, stepsDuration, type TargetContext } from "@/lib/planning/workouts";
import type { Baseline } from "@/lib/planning/types";

const hrZones = [1, 2, 3, 4, 5].map((z) => ({ zone: z as 1 | 2 | 3 | 4 | 5, label: "", minBpm: 100 + z * 15, maxBpm: 114 + z * 15 }));
const ctx: TargetContext = { baseline: { paceZones: trainingPaces(41.5), hrZones } as unknown as Baseline, racePace: 330, raceLabel: "10 km" };
const check = { longest30Min: 50, weekOtherMin: 100, weekOtherHardMin: 0, ctx };

describe("editing workout steps", () => {
  it("round-trips planned steps and keeps their targets", () => {
    const w = buildWorkout({ type: "vo2max", progress: 0.5 }, ctx);
    const again = rebuildSteps(toEditable(w.steps), ctx);
    expect(again).toEqual(w.steps);
  });

  it("uses your own pace and estimates time for distance steps", () => {
    const steps = rebuildSteps(
      [{ kind: "warmup", durationS: 600, zone: "easy" }, { kind: "repeat", count: 5, steps: [{ kind: "run", distanceM: 1000, zone: "interval", paceFast: 280, paceSlow: 290 }, { kind: "recover", durationS: 120, zone: "recovery" }] }],
      ctx,
    );
    const rep = steps[1] as Extract<(typeof steps)[number], { kind: "repeat" }>;
    const work = rep.steps[0] as Exclude<(typeof steps)[number], { kind: "repeat" }>;
    expect(work.durationS).toBe(285);
    expect(work.target.label).toContain("(your pace)");
    expect(stepsDuration(steps)).toBe(600 + 5 * (285 + 120));
    expect(titleFor("vo2max", steps)).toBe("5 × 1 km interval");
  });

  it("refuses a distance step with no pace to estimate time from", () => {
    expect(() => rebuildSteps([{ kind: "run", distanceM: 2000, zone: "hill" }], ctx)).toThrow(/time instead of a distance/);
  });

  it("validates input", () => {
    expect(editableSteps.safeParse([]).success).toBe(false);
    expect(editableSteps.safeParse([{ kind: "run", durationS: 600, zone: "nope" }]).success).toBe(false);
    expect(editableSteps.safeParse([{ kind: "run", durationS: 600, zone: "easy" }]).success).toBe(true);
  });

  it("warns about a run spike, too much hard running and paces beyond your fitness", () => {
    const long = rebuildSteps([{ kind: "run", durationS: 70 * 60, zone: "easy" }], ctx);
    expect(editIssues("long", long, check).join(" ")).toMatch(/10 % longer/);
    const hard = rebuildSteps([{ kind: "repeat", count: 8, steps: [{ kind: "run", durationS: 300, zone: "threshold" }, { kind: "recover", durationS: 60, zone: "recovery" }] }], ctx);
    expect(editIssues("threshold", hard, check).join(" ")).toMatch(/20 %/);
    const fast = rebuildSteps([{ kind: "run", durationS: 600, zone: "threshold", paceFast: 220, paceSlow: 225 }], ctx);
    expect(editIssues("threshold", fast, check).join(" ")).toMatch(/faster than your current threshold/);
    const fine = rebuildSteps([{ kind: "run", durationS: 40 * 60, zone: "easy" }], ctx);
    expect(editIssues("easy", fine, check)).toEqual([]);
  });
});
