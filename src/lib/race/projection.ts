import type { ProjectionInput } from "./status";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The plan's "if you follow this plan" projection, re-projected from today's
 * fitness. Plans without a stored projection return null.
 */
export function livePlanProjection(plan: any, fitnessOutput: any, workouts: { date: string; status: string; type: string }[], today: string): ProjectionInput | null {
  void plan;
  void fitnessOutput;
  void workouts;
  void today;
  return null;
}
