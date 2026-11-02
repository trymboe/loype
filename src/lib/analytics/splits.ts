import type { ActivityStreams } from "../fit/types";
import type { MotionSummary } from "./motion";

/**
 * splits@2 — fixed-distance splits (default 1 km) computed from the
 * cumulative distance stream.
 *
 * Each sample interval is apportioned to splits by distance, so a boundary
 * falling inside an interval is linearly interpolated. Paused intervals add
 * no distance and are excluded from moving time; "stopped" time (timer running,
 * not moving) counts towards elapsed but not moving time.
 * Pace is moving time / distance. HR and cadence are time-weighted over moving
 * intervals. Elevation gain uses a 2 m hysteresis per split.
 */
export interface Split {
  index: number; // 0-based
  distanceM: number;
  elapsedS: number;
  movingS: number;
  paceSecPerKm: number | null;
  avgHr: number | null;
  avgCadence: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  partial: boolean;
}

export function computeSplits(
  s: ActivityStreams,
  motion: MotionSummary,
  splitM = 1000,
  minPartialM = 50,
): Split[] {
  if (motion.distanceSource === "none") return [];
  const total = motion.distance[motion.distance.length - 1] ?? 0;
  if (total <= 0) return [];
  const count = Math.ceil(total / splitM);

  const acc = Array.from({ length: count }, () => ({
    dist: 0,
    elapsed: 0,
    moving: 0,
    hrSum: 0,
    hrT: 0,
    cadSum: 0,
    cadT: 0,
    alts: [] as number[],
  }));

  for (const iv of motion.intervals) {
    const d0 = motion.distance[iv.i - 1];
    const d1 = motion.distance[iv.i];
    const hr = s.hr[iv.i];
    const cad = s.cadence[iv.i];
    if (d1 <= d0) {
      // no distance gained: attribute time to the split we are currently in
      const k = Math.min(count - 1, Math.floor(d0 / splitM));
      acc[k].elapsed += iv.dt;
      if (iv.state === "moving") acc[k].moving += iv.dt;
      continue;
    }
    // apportion across one or more split boundaries
    let from = d0;
    while (from < d1 - 1e-9) {
      const k = Math.min(count - 1, Math.floor(from / splitM));
      const boundary = (k + 1) * splitM;
      const to = Math.min(d1, boundary);
      const frac = (to - from) / (d1 - d0);
      const dt = iv.dt * frac;
      const a = acc[k];
      a.dist += to - from;
      a.elapsed += dt;
      if (iv.state === "moving") {
        a.moving += dt;
        if (hr != null) {
          a.hrSum += hr * dt;
          a.hrT += dt;
        }
        if (cad != null && cad > 0) {
          a.cadSum += cad * dt;
          a.cadT += dt;
        }
      }
      from = to;
      if (k === count - 1 && to >= d1) break;
    }
  }

  // altitude per split by sample distance
  for (let i = 0; i < s.t.length; i++) {
    const alt = s.altitude[i];
    if (alt == null) continue;
    const k = Math.min(count - 1, Math.floor(motion.distance[i] / splitM));
    acc[k].alts.push(alt);
  }

  const out: Split[] = [];
  acc.forEach((a, index) => {
    // Only the final split can be partial. The first one can be a few metres
    // short because the watch's first sample is already past 0 m; that must
    // not turn "km 1" into a "0.99 km partial" split.
    const partial = index === count - 1 && a.dist < splitM - 1;
    if (partial && a.dist < minPartialM) return;
    let gain: number | null = null;
    let loss: number | null = null;
    if (a.alts.length >= 2) {
      gain = 0;
      loss = 0;
      let anchor = a.alts[0];
      for (const x of a.alts) {
        if (x - anchor >= 2) {
          gain += x - anchor;
          anchor = x;
        } else if (anchor - x >= 2) {
          loss += anchor - x;
          anchor = x;
        }
      }
    }
    out.push({
      index,
      distanceM: a.dist,
      elapsedS: a.elapsed,
      movingS: a.moving,
      paceSecPerKm: a.dist > 0 && a.moving > 0 ? (a.moving / a.dist) * 1000 : null,
      avgHr: a.hrT > 0 ? a.hrSum / a.hrT : null,
      avgCadence: a.cadT > 0 ? a.cadSum / a.cadT : null,
      elevationGainM: gain,
      elevationLossM: loss,
      partial,
    });
  });
  return out;
}
