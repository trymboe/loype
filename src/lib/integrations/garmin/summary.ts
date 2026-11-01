/**
 * Lenient extraction of the few fields we need from Garmin activity-list
 * entries. The full JSON is always stored as received (raw_activity_sources.summary);
 * all activity metrics come from the FIT file, not from this summary.
 */
export interface GarminActivityRef {
  externalId: string;
  type: string | null;
  startTime: Date | null;
  name: string | null;
  raw: unknown;
}

/** Garmin type keys we treat as runs. Everything else is recorded but skipped. */
export const RUNNING_TYPES = new Set([
  "running",
  "trail_running",
  "treadmill_running",
  "track_running",
  "street_running",
  "indoor_running",
  "virtual_run",
  "ultra_run",
  "obstacle_run",
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseActivityRef(entry: any): GarminActivityRef | null {
  if (!entry || typeof entry !== "object") return null;
  const id = entry.activityId ?? entry.activityID ?? entry.id ?? entry.summaryId;
  if (id == null) return null;
  const typeRaw = entry.activityType;
  const type =
    typeof typeRaw === "string" ? typeRaw : (typeRaw?.typeKey ?? typeRaw?.key ?? null);
  return {
    externalId: String(id),
    type: type ? String(type).toLowerCase() : null,
    startTime: parseGarminTime(entry.startTimeGMT ?? entry.startTimeGmt, true) ?? parseGarminTime(entry.startTimeInSeconds) ?? parseGarminTime(entry.startTimeLocal, false),
    name: typeof entry.activityName === "string" ? entry.activityName : null,
    raw: entry,
  };
}

/** Garmin uses "YYYY-MM-DD HH:mm:ss" strings (GMT or local) or epoch seconds/ms. */
export function parseGarminTime(v: unknown, isUtc = true): Date | null {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v > 1e11 ? v : v * 1000);
  if (typeof v !== "string") return null;
  const iso = v.includes("T") ? v : v.replace(" ", "T");
  const d = new Date(isUtc && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? `${iso}Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isRunningType(type: string | null): boolean {
  if (!type) return true; // unknown type: download and let the FIT sport decide
  return RUNNING_TYPES.has(type) || type.includes("run");
}
