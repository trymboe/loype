import type { GarminPersonalApiClient } from "../integrations/garmin/client";
import type { IngestRepo, WellnessObservation } from "./types";

/**
 * Wellness sync (supplementary signals: resting HR, HRV, sleep, stress, Body Battery).
 *
 * The Personal API's JSON field names are not in the readable docs, so values
 * are extracted from a list of candidate field names used by Garmin Connect,
 * and the raw day object is always stored so it can be re-extracted later.
 * A metric whose value cannot be found is stored as null, never guessed.
 * Each endpoint is independent: one failing does not block the others.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Extractor = { metric: string; unit: string; paths: string[] };

function get(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function firstNumber(obj: any, paths: string[]): number | null {
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}
function dateOf(obj: any): string | null {
  const d = obj?.calendarDate ?? obj?.date ?? obj?.summaryDate ?? obj?.dailySleepDTO?.calendarDate ?? obj?.startDate;
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}
function asList(payload: any, keys: string[]): any[] {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return payload && typeof payload === "object" ? [payload] : [];
}

export function extractDaily(payload: unknown, listKeys: string[], extractors: Extractor[]): WellnessObservation[] {
  const out: WellnessObservation[] = [];
  for (const day of asList(payload, listKeys)) {
    const date = dateOf(day);
    if (!date) continue;
    for (const ex of extractors) {
      const value = firstNumber(day, ex.paths);
      out.push({ calendarDate: date, metric: ex.metric, value, unit: ex.unit, raw: day });
    }
  }
  return out;
}

export const WELLNESS_SOURCES: {
  name: string;
  fetch: (c: GarminPersonalApiClient, start: string, end: string) => Promise<unknown>;
  listKeys: string[];
  extractors: Extractor[];
}[] = [
  {
    name: "daily summaries",
    fetch: (c, s, e) => c.dailySummaries(s, e),
    listKeys: ["dailySummaries", "summaries", "values"],
    extractors: [
      { metric: "resting_hr", unit: "bpm", paths: ["restingHeartRate", "restingHeartRateInBeatsPerMinute"] },
      { metric: "steps", unit: "count", paths: ["totalSteps", "steps"] },
    ],
  },
  {
    name: "sleep",
    fetch: (c, s, e) => c.sleepSummaries(s, e),
    listKeys: ["dailySleepSummaries", "sleepSummaries", "values"],
    extractors: [
      { metric: "sleep_seconds", unit: "s", paths: ["sleepTimeSeconds", "dailySleepDTO.sleepTimeSeconds", "durationInSeconds"] },
      { metric: "sleep_score", unit: "score", paths: ["sleepScores.overall.value", "dailySleepDTO.sleepScores.overall.value", "overallSleepScore.value", "sleepScore"] },
    ],
  },
  {
    name: "hrv",
    fetch: (c, s, e) => c.hrvDaily(s, e),
    listKeys: ["hrvSummaries", "values"],
    extractors: [{ metric: "hrv_overnight_avg", unit: "ms", paths: ["lastNightAvg", "hrvSummary.lastNightAvg", "lastNightAvgHrv"] }],
  },
  {
    name: "stress",
    fetch: (c, s, e) => c.stressDaily(s, e),
    listKeys: ["values", "allMetrics.metricsMap", "dailyStress"],
    extractors: [{ metric: "stress_avg", unit: "score", paths: ["values.overallStressLevel", "overallStressLevel", "averageStressLevel", "avgStressLevel"] }],
  },
  {
    name: "body battery",
    fetch: (c, s, e) => c.bodyBatteryDaily(s, e),
    listKeys: ["values", "bodyBatteryReports"],
    extractors: [
      { metric: "body_battery_high", unit: "score", paths: ["charged", "bodyBatteryHighestValue", "highest"] },
      { metric: "body_battery_low", unit: "score", paths: ["drained", "bodyBatteryLowestValue", "lowest"] },
    ],
  },
];

export interface WellnessResult {
  stored: number;
  errors: { source: string; message: string }[];
}

/** Sync wellness for an inclusive date range (YYYY-MM-DD), in ≤28-day chunks. */
export async function syncWellness(client: GarminPersonalApiClient, repo: IngestRepo, start: string, end: string): Promise<WellnessResult> {
  const result: WellnessResult = { stored: 0, errors: [] };
  const chunks: [string, string][] = [];
  let cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    const chunkEnd = new Date(Math.min(last.getTime(), cur.getTime() + 27 * 86400_000));
    chunks.push([cur.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    cur = new Date(chunkEnd.getTime() + 86400_000);
  }
  for (const src of WELLNESS_SOURCES) {
    for (const [s, e] of chunks) {
      try {
        const payload = await src.fetch(client, s, e);
        const obs = extractDaily(payload, src.listKeys, src.extractors);
        result.stored += await repo.saveWellness(obs);
      } catch (err) {
        result.errors.push({ source: src.name, message: err instanceof Error ? err.message : String(err) });
        break; // skip the rest of this source; others continue
      }
    }
  }
  return result;
}
