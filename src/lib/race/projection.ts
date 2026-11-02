import { addDaysIso, weekStart } from "../dates";
import { adherence, liveProjection, type Projection } from "../planning/projection";
import type { PlanWeek } from "../planning/types";
import type { ProjectionInput } from "./status";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The plan's "if you follow this plan" projection, re-projected from today's
 * fitness the same way the Plan page does. Falls back to the projection
 * stored at plan start when there is no current estimate; plans without a
 * stored projection return null.
 */
export function livePlanProjection(plan: any, fitnessOutput: any, workouts: { date: string; status: string; type: string }[], today: string): ProjectionInput | null {
  const start = (plan?.config?.projection ?? null) as Projection | null;
  if (!start) return null;
  const est = fitnessOutput?.estimate;
  let p: Projection = start;
  if (est && !est.withheld) {
    const thisWeek = weekStart(today);
    const remainingWeeks = ((plan.weeks ?? []) as PlanWeek[]).filter((w) => w.start >= thisWeek && w.phase !== "taper" && w.phase !== "race").length;
    p = liveProjection(start, {
      vdot: est.vdot,
      remainingWeeks,
      adherence: adherence(workouts, today, addDaysIso(today, -28)),
      currentLongestM: fitnessOutput.longestRecentM ?? 0,
      asOf: today,
    });
  }
  return { projectedS: p.projectedS, fastS: p.fastS, slowS: p.slowS };
}
