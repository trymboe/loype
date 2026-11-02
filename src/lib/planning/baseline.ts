/**
 * The starting point a plan is built from: current fitness (from the fitness
 * model) and what you have actually been running lately. Pure.
 */
import { addDaysIso, weekStart } from "../dates";
import type { HrZone } from "../analytics/fitness/physiology";
import type { PaceZone } from "../analytics/fitness/vdot";
import type { Baseline } from "./types";

export interface BaselineRun {
  date: string;
  movingS: number | null;
  distanceM: number | null;
}

export interface BaselineFitness {
  estimate: { withheld: boolean; vdot?: number; lower?: number; upper?: number; confidence?: "high" | "medium" | "low" } | null;
  paceZones: PaceZone[] | null;
  hrZones: HrZone[] | null;
  threshold: { hr: number | null } | null;
  predictions: { distanceM: number; timeS: number }[] | null;
}

export function buildBaseline(asOf: string, fitness: BaselineFitness | null, runs: BaselineRun[]): Baseline {
  // the last 4 complete-or-current weeks ending at asOf
  const from28 = addDaysIso(asOf, -27);
  const recent = runs.filter((r) => r.date >= from28 && r.date <= asOf);
  const sumMin = recent.reduce((a, r) => a + (r.movingS ?? 0) / 60, 0);
  const sumKm = recent.reduce((a, r) => a + (r.distanceM ?? 0) / 1000, 0);

  const thisWeek = weekStart(asOf);
  let weeksWithRuns = 0;
  for (let w = 0; w < 8; w++) {
    const s = addDaysIso(thisWeek, -7 * w);
    const e = addDaysIso(s, 6);
    if (runs.some((r) => r.date >= s && r.date <= e)) weeksWithRuns++;
  }
  const from56 = addDaysIso(asOf, -55);
  const longest = Math.max(0, ...runs.filter((r) => r.date >= from56 && r.date <= asOf).map((r) => (r.movingS ?? 0) / 60));

  const e = fitness?.estimate;
  const has = e && !e.withheld && e.vdot != null;
  return {
    asOf,
    vdot: has ? e!.vdot! : null,
    vdotRange: has && e!.lower != null && e!.upper != null ? [e!.lower, e!.upper] : null,
    vdotConfidence: has ? (e!.confidence ?? null) : null,
    paceZones: has ? fitness!.paceZones : null,
    hrZones: fitness?.hrZones ?? null,
    thresholdHr: fitness?.threshold?.hr ?? null,
    weeklyMinutes: Math.round(sumMin / 4),
    weeklyKm: Math.round((sumKm / 4) * 10) / 10,
    runsPerWeek: Math.round((recent.length / 4) * 10) / 10,
    consistency: weeksWithRuns / 8,
    longestRunMinutes: Math.round(longest),
    predictions: has ? (fitness!.predictions ?? []).map((p) => ({ distanceM: p.distanceM, timeS: p.timeS })) : [],
  };
}
