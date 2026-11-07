/**
 * Running load (`running-load@1`): how much running a run was, beyond its
 * distance, in "equivalent km". Pure.
 *
 *   load = (km + elevation gain / 100 m) × intensity factor
 *
 * Climb: 100 m of ascent ≈ 1 flat km. This is the ITRA "km-effort" rule
 * (International Trail Running Association: km-effort = distance in km +
 * ascent in m / 100), the usual convention for comparing hilly and flat runs.
 *
 * Intensity: from the run's time in heart-rate-reserve zones (activity_scores
 * zone_seconds, computed by the fitness model), else its overall intensity
 * (HRR fraction or pace-estimated, same source). Weights come from Banister
 * TRIMP (fitness/scoring.ts): per minute, zone 4 (80–90 % HRR) weighs ~1.9× an
 * easy minute at 65 % HRR and zone 5 ~2.6×; per km, since faster running covers
 * more ground per minute, that is ~1.5× and ~2×. So the factor is
 * 1 + 0.5 × share in zone 4 + 1.0 × share in zone 5. Easy running is 1.
 *
 * The weekly ratio compares the last week with the 4-week weekly average
 * (acute:chronic, Gabbett 2016). For running, weekly ratios are weaker
 * evidence than the single-run distance rule (Frandsen et al. 2025), so the
 * planner uses this only to hold growth back, never to allow more.
 */
import { addDaysIso } from "../dates";
import { VERSIONS } from "./versions";

export const RUNNING_LOAD_VERSION = VERSIONS.runningLoad;
/** metres of ascent counted as one flat km (ITRA km-effort) */
export const CLIMB_M_PER_KM = 100;
/** above this acute:chronic load ratio, the coming week grows less than usual */
export const LOAD_RATIO_HIGH = 1.3;
/** at or above this ratio, the coming week does not grow past your 4-week average */
export const LOAD_RATIO_HOLD = 1.6;
/** at or above this ratio, the next hard session is a candidate for an easy run */
export const LOAD_RATIO_SPIKE = 1.5;

export interface RunLoadInput {
  distanceM: number | null;
  elevationGainM?: number | null;
  /** seconds below zone 1, then zones 1–5 */
  zoneSeconds?: number[] | null;
  /** fraction of HR reserve (or estimated from pace), 0..1.05 */
  intensity?: number | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function intensityFactor(zoneSeconds?: number[] | null, intensity?: number | null): number {
  const total = zoneSeconds?.reduce((a, s) => a + (s > 0 ? s : 0), 0) ?? 0;
  if (zoneSeconds && zoneSeconds.length >= 6 && total > 0) {
    return 1 + (0.5 * Math.max(0, zoneSeconds[4])) / total + (1.0 * Math.max(0, zoneSeconds[5])) / total;
  }
  if (intensity != null && Number.isFinite(intensity)) {
    // the same scale from an average: 1 below 75 % HRR, 1.5 at 90 %, 2 at 100 %
    return 1 + 0.5 * clamp01((intensity - 0.75) / 0.15) + 0.5 * clamp01((intensity - 0.9) / 0.1);
  }
  return 1;
}

/** Equivalent km for one run. */
export function runLoad(r: RunLoadInput): number {
  const km = Math.max(0, r.distanceM ?? 0) / 1000;
  if (km === 0) return 0;
  const climb = Math.max(0, r.elevationGainM ?? 0) / CLIMB_M_PER_KM;
  return (km + climb) * intensityFactor(r.zoneSeconds, r.intensity);
}

export interface LoadRatio {
  /** load of the 7 days ending asOf, equivalent km */
  acute: number;
  /** weekly average over the 28 days ending asOf */
  chronic: number;
  ratio: number;
}

/**
 * Acute:chronic running load at asOf. Null without enough history (runs in
 * fewer than 3 of the four 7-day blocks), since a first week back would always
 * look like a spike; a return after a break has its own rule.
 */
export function loadRatio(runs: { date: string; load: number }[], asOf: string): LoadRatio | null {
  const blocks = [3, 2, 1, 0].map((k) => {
    const e = addDaysIso(asOf, -7 * k);
    const s = addDaysIso(e, -6);
    return runs.filter((r) => r.date >= s && r.date <= e && r.load > 0).reduce((a, r) => a + r.load, 0);
  });
  return weeklyLoadRatio(blocks);
}

/** The same from four weekly totals, oldest first (the last is the acute week). */
export function weeklyLoadRatio(weeks: number[]): LoadRatio | null {
  if (weeks.length !== 4 || weeks.filter((b) => b > 0).length < 3) return null;
  const chronic = weeks.reduce((a, b) => a + b, 0) / 4;
  if (chronic <= 0) return null;
  const acute = weeks[3];
  return { acute: r1(acute), chronic: r1(chronic), ratio: Math.round((acute / chronic) * 100) / 100 };
}

/**
 * Share (0..1) of the usual growth headroom the next week keeps after a
 * high-load week: 1 up to LOAD_RATIO_HIGH, falling linearly to 0 (no growth
 * past your 4-week average) at LOAD_RATIO_HOLD.
 */
export function loadTemper(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= LOAD_RATIO_HIGH) return 1;
  return Math.round(clamp01((LOAD_RATIO_HOLD - ratio) / (LOAD_RATIO_HOLD - LOAD_RATIO_HIGH)) * 100) / 100;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
