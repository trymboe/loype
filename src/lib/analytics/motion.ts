import type { ActivityStreams, Maybe, TimerEvent } from "../fit/types";
import { haversine } from "./geo";

/**
 * moving-time@1
 *
 * Classifies every interval between consecutive samples as
 *  - "paused":  the device timer was stopped (manual or auto-pause), or
 *  - "moving":  timer running and speed ≥ MOVING_SPEED_MS, or
 *  - "stopped": timer running but standing still (traffic lights etc.).
 *
 * Speed per interval comes from the distance stream (Δd/Δt) when available,
 * otherwise from the recorded speed, otherwise from GPS positions.
 * Gaps longer than MAX_SAMPLE_GAP_S are treated as moving only if the runner
 * covered ground at a plausible pace across the gap.
 */
export const MOVING_SPEED_MS = 0.8; // ≈ 20:50 min/km; slower than any running or brisk walking
export const MAX_SAMPLE_GAP_S = 30;

export type IntervalState = "moving" | "stopped" | "paused";

export interface MotionInterval {
  /** index of the sample that ends this interval (i), starting sample is i-1 */
  i: number;
  dt: number;
  dd: number; // metres covered in the interval (0 if unknown)
  speed: number | null;
  state: IntervalState;
}

export interface MotionSummary {
  intervals: MotionInterval[];
  elapsedS: number;
  movingS: number;
  stoppedS: number;
  pausedS: number;
  /** Best available cumulative distance per sample (metres). */
  distance: number[];
  distanceSource: "device" | "gps" | "none";
}

export function timerRunningAt(events: TimerEvent[], t: number): boolean {
  if (events.length === 0) return true;
  let running = events[0].type === "stop"; // if first event is a stop, timer was running before it
  for (const e of events) {
    if (e.t > t) break;
    running = e.type === "start";
  }
  return running;
}

/** Cumulative distance per sample: device distance if present, else integrated GPS. */
export function bestDistance(s: ActivityStreams): { distance: number[]; source: MotionSummary["distanceSource"] } {
  const n = s.t.length;
  const devCount = s.distance.filter((d) => d != null).length;
  if (n > 0 && devCount / n >= 0.5) {
    const out: number[] = new Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const d = s.distance[i];
      // forward-fill gaps and never let distance go backwards
      last = d != null && d >= last ? d : last;
      out[i] = last;
    }
    return { distance: out, source: "device" };
  }
  const gpsCount = s.lat.filter((d) => d != null).length;
  if (n > 0 && gpsCount / n >= 0.5) {
    const out: number[] = new Array(n).fill(0);
    let lastIdx = -1;
    for (let i = 0; i < n; i++) {
      const la = s.lat[i];
      const ln = s.lng[i];
      if (lastIdx >= 0 && la != null && ln != null) {
        out[i] = out[lastIdx] + haversine(s.lat[lastIdx]!, s.lng[lastIdx]!, la, ln);
        // fill skipped indices
        for (let k = lastIdx + 1; k < i; k++) out[k] = out[lastIdx];
      } else if (i > 0) {
        out[i] = out[i - 1];
      }
      if (la != null && ln != null) lastIdx = i;
    }
    return { distance: out, source: "gps" };
  }
  return { distance: new Array(n).fill(0), source: "none" };
}

export function analyzeMotion(s: ActivityStreams, timerEvents: TimerEvent[]): MotionSummary {
  const n = s.t.length;
  const { distance, source } = bestDistance(s);
  const intervals: MotionInterval[] = [];
  let movingS = 0;
  let stoppedS = 0;
  let pausedS = 0;

  for (let i = 1; i < n; i++) {
    const dt = s.t[i] - s.t[i - 1];
    if (dt <= 0) continue;
    const dd = Math.max(0, distance[i] - distance[i - 1]);
    let speed: number | null = source !== "none" ? dd / dt : null;
    if (speed == null || (source === "none" && s.speed[i] != null)) speed = s.speed[i] ?? null;

    const mid = (s.t[i] + s.t[i - 1]) / 2;
    let state: IntervalState;
    if (!timerRunningAt(timerEvents, mid)) state = "paused";
    else if (speed == null) state = "moving"; // no distance info at all (e.g. HR-only): trust the timer
    // Long gaps (smart recording, signal loss) count as moving only if the
    // average speed across the gap is plausible running/walking speed.
    else state = speed >= MOVING_SPEED_MS ? "moving" : "stopped";

    if (state === "moving") movingS += dt;
    else if (state === "stopped") stoppedS += dt;
    else pausedS += dt;
    intervals.push({ i, dt, dd, speed, state });
  }

  return {
    intervals,
    elapsedS: n > 0 ? s.t[n - 1] - s.t[0] : 0,
    movingS,
    stoppedS,
    pausedS,
    distance,
    distanceSource: source,
  };
}

/**
 * Elevation gain/loss with a hysteresis threshold to suppress barometric/GPS
 * noise: altitude changes are only counted once they exceed `thresholdM`
 * from the last anchor point.
 */
export function elevationGainLoss(alt: Maybe[], thresholdM = 2): { gain: number; loss: number } | null {
  let anchor: number | null = null;
  let gain = 0;
  let loss = 0;
  let count = 0;
  for (const a of alt) {
    if (a == null) continue;
    count++;
    if (anchor == null) {
      anchor = a;
      continue;
    }
    const diff = a - anchor;
    if (diff >= thresholdM) {
      gain += diff;
      anchor = a;
    } else if (diff <= -thresholdM) {
      loss += -diff;
      anchor = a;
    }
  }
  if (count < 2) return null;
  return { gain, loss };
}
