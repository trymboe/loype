/**
 * Strava activity JSON (DetailedActivity + streams) → NormalizedActivity.
 *
 * Strava doesn't hand out the original file for other people's devices (Apple
 * Watch runs reach Strava through Apple Health), so the raw source Løype
 * stores is this JSON bundle, and everything downstream (motion, splits,
 * quality, fitness) works from the streams exactly as it does for FIT files.
 */
import type { Maybe, NormalizedActivity, NormalizedLap, TimerEvent } from "../../fit/types";
import type { StravaStreams, StravaSummaryActivity } from "./client";

export const STRAVA_BUNDLE_VERSION = 1;

export interface StravaBundle {
  version: number;
  activity: StravaSummaryActivity;
  streams: StravaStreams;
}

export class StravaParseError extends Error {}

/** Strava sport types Løype imports as runs. Everything else is recorded and skipped. */
export const STRAVA_RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

export function stravaType(a: { sport_type?: string; type?: string }): string | null {
  return a.sport_type ?? a.type ?? null;
}

/** Gap in the time stream (seconds) that, with almost no distance covered, means the watch was paused. */
const PAUSE_GAP_S = 20;
const PAUSE_MAX_SPEED_MS = 0.3;

const num = (v: unknown): Maybe => (typeof v === "number" && Number.isFinite(v) ? v : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function encodeBundle(activity: StravaSummaryActivity, streams: StravaStreams): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: STRAVA_BUNDLE_VERSION, activity, streams } satisfies StravaBundle));
}

export function decodeBundle(bytes: Uint8Array): StravaBundle {
  let b: StravaBundle;
  try {
    b = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new StravaParseError("Stored Strava data is not valid JSON");
  }
  if (!b || typeof b !== "object" || !b.activity || typeof b.streams !== "object") throw new StravaParseError("Stored Strava data is incomplete");
  return b;
}

function sportOf(a: StravaSummaryActivity): { sport: string; subSport: string | null } {
  const t = stravaType(a);
  if (t === "TrailRun") return { sport: "running", subSport: "trail" };
  if (t === "VirtualRun") return { sport: "running", subSport: "virtual_activity" };
  if (t === "Run") return { sport: "running", subSport: a.trainer ? "treadmill" : "generic" };
  if (t === "Walk") return { sport: "walking", subSport: null };
  if (t === "Hike") return { sport: "hiking", subSport: null };
  return { sport: (t ?? "unknown").toLowerCase(), subSport: null };
}

function deviceOf(a: StravaSummaryActivity): NormalizedActivity["device"] {
  const name: string | null = typeof a.device_name === "string" && a.device_name.trim() ? a.device_name.trim() : null;
  const lower = name?.toLowerCase() ?? "";
  const manufacturer = !name ? null : lower.includes("apple") ? "apple" : lower.includes("garmin") ? "garmin" : lower.split(/\s+/)[0];
  return { manufacturer, product: name, serial: null };
}

export function normalizeStrava(bundle: StravaBundle): NormalizedActivity {
  const a = bundle.activity;
  const s = bundle.streams;
  const warnings: string[] = [];
  if (!a.start_date || Number.isNaN(Date.parse(a.start_date))) throw new StravaParseError("Strava activity has no start time");
  const time = (s.time?.data ?? []).map(Number);
  if (time.length < 2) throw new StravaParseError("Strava activity has no recorded samples (manual entry?)");
  const n = time.length;

  const col = (key: string): Maybe[] => {
    const d = s[key]?.data;
    if (!Array.isArray(d) || d.length !== n) {
      if (Array.isArray(d)) warnings.push(`Strava ${key} stream length ${d.length} ≠ ${n}; ignored`);
      return new Array(n).fill(null);
    }
    return d.map(num);
  };

  const latlng = s.latlng?.data;
  const hasLatLng = Array.isArray(latlng) && latlng.length === n;
  if (Array.isArray(latlng) && !hasLatLng) warnings.push(`Strava latlng stream length ${latlng.length} ≠ ${n}; ignored`);
  const lat: Maybe[] = hasLatLng ? latlng.map((p: unknown) => (Array.isArray(p) ? num(p[0]) : null)) : new Array(n).fill(null);
  const lng: Maybe[] = hasLatLng ? latlng.map((p: unknown) => (Array.isArray(p) ? num(p[1]) : null)) : new Array(n).fill(null);

  const { sport, subSport } = sportOf(a);
  const isRun = sport === "running";

  // Strava reports running cadence per leg (strides/min); Løype stores steps/min.
  let cadence = col("cadence");
  const cadMedian = median(cadence.filter((v): v is number => v != null && v > 0));
  const doubleCadence = isRun && cadMedian != null && cadMedian < 120;
  if (doubleCadence) cadence = cadence.map((v) => (v == null ? null : v * 2));
  const cad = (v: unknown) => {
    const x = num(v);
    return x == null ? null : doubleCadence ? x * 2 : x;
  };

  const distance = col("distance");
  // Paused stretches: Strava drops samples while the watch is paused, leaving a long gap with no distance.
  const timerEvents: TimerEvent[] = [];
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt < PAUSE_GAP_S) continue;
    const d0 = distance[i - 1];
    const d1 = distance[i];
    const dd = d0 != null && d1 != null ? Math.max(0, d1 - d0) : null;
    if (dd != null && dd / dt <= PAUSE_MAX_SPEED_MS) {
      timerEvents.push({ t: time[i - 1], type: "stop" }, { t: time[i], type: "start" });
    }
  }
  if (timerEvents.length) timerEvents.unshift({ t: time[0], type: "start" });

  const laps: NormalizedLap[] = (Array.isArray(a.laps) ? a.laps : []).map((l: Record<string, unknown>, i: number) => {
    const startIdx = num(l.start_index);
    return {
      index: i,
      startOffsetS: startIdx != null && startIdx >= 0 && startIdx < n ? time[startIdx] - time[0] : 0,
      elapsedS: num(l.elapsed_time),
      timerS: num(l.moving_time),
      distanceM: num(l.distance),
      avgSpeed: num(l.average_speed),
      maxSpeed: num(l.max_speed),
      avgHr: num(l.average_heartrate),
      maxHr: num(l.max_heartrate),
      avgCadence: cad(l.average_cadence),
      totalAscentM: num(l.total_elevation_gain),
      intensity: null,
      trigger: null,
      workoutStepIndex: null,
    };
  });

  return {
    sport,
    subSport,
    startTime: new Date(a.start_date),
    utcOffsetS: num(a.utc_offset),
    device: deviceOf(a),
    totals: {
      distanceM: num(a.distance),
      elapsedS: num(a.elapsed_time),
      timerS: null, // Strava's moving_time is its own estimate, not the watch timer: derived from the streams instead
      avgHr: num(a.average_heartrate),
      maxHr: num(a.max_heartrate),
      avgCadence: cad(a.average_cadence),
      totalAscentM: num(a.total_elevation_gain),
      totalDescentM: null,
      calories: num(a.calories),
      avgSpeed: num(a.average_speed),
      maxSpeed: num(a.max_speed),
    },
    laps,
    streams: {
      t: time.map((v) => v - time[0]),
      distance,
      speed: col("velocity_smooth"),
      hr: col("heartrate"),
      cadence,
      altitude: col("altitude"),
      lat,
      lng,
    },
    timerEvents: timerEvents.map((e) => ({ ...e, t: e.t - time[0] })),
    warnings,
  };
}
