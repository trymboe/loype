/**
 * dedupe@1 — cross-source duplicate detection.
 *
 * Same-source duplicates are prevented by the (provider, external_id) unique
 * key. This function catches the same run arriving through two paths (e.g. a
 * Garmin import and a manual FIT upload): starts within 2 minutes, and both
 * duration and distance within tolerance.
 */
export interface DedupeCandidate {
  id?: string;
  startTime: Date;
  elapsedS: number | null;
  distanceM: number | null;
}

export const DEDUPE_START_TOLERANCE_S = 120;
export const DEDUPE_DURATION_TOLERANCE = 0.1;
export const DEDUPE_DISTANCE_TOLERANCE = 0.05;

function within(a: number | null, b: number | null, rel: number): boolean {
  if (a == null || b == null) return true; // cannot disprove
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= rel;
}

export function isLikelyDuplicate(a: DedupeCandidate, b: DedupeCandidate): boolean {
  const dt = Math.abs(a.startTime.getTime() - b.startTime.getTime()) / 1000;
  if (dt > DEDUPE_START_TOLERANCE_S) return false;
  if (a.elapsedS == null && a.distanceM == null) return false;
  return within(a.elapsedS, b.elapsedS, DEDUPE_DURATION_TOLERANCE) && within(a.distanceM, b.distanceM, DEDUPE_DISTANCE_TOLERANCE);
}

export function findDuplicate<T extends DedupeCandidate>(candidate: DedupeCandidate, existing: T[]): T | null {
  return existing.find((e) => isLikelyDuplicate(candidate, e)) ?? null;
}
