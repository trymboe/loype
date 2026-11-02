/**
 * Pure helpers for inspecting part of a run on the activity page: summarising a
 * selected stretch of the chart series, and comparing laps.
 */
import type { ChartPoint } from "./series";

export interface SegmentSummary {
  startIdx: number;
  endIdx: number;
  distanceM: number;
  elapsedS: number;
  /** Time spent moving (intervals whose end sample has a pace). */
  movingS: number;
  /** Moving time / distance; null under 50 m (too short to mean anything). */
  paceSPerKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  elevGainM: number | null;
  elevLossM: number | null;
  /** HR change from the first to the last fifth of the stretch. */
  hrDriftBpm: number | null;
}

/** Index of the point whose x value (km or s) is closest to `x`. Points must be sorted by that key. */
export function nearestIndex(points: ChartPoint[], key: "d" | "t", x: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][key] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][key] - x) <= Math.abs(points[hi][key] - x) ? lo : hi;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function summarizeSegment(points: ChartPoint[], a: number, b: number): SegmentSummary | null {
  const i0 = Math.max(0, Math.min(a, b));
  const i1 = Math.min(points.length - 1, Math.max(a, b));
  if (i1 <= i0) return null;
  const seg = points.slice(i0, i1 + 1);
  const distanceM = (seg[seg.length - 1].d - seg[0].d) * 1000;
  const elapsedS = seg[seg.length - 1].t - seg[0].t;
  let movingS = 0;
  // time-weighted HR / cadence over moving intervals
  let hrW = 0;
  let hrT = 0;
  let cadW = 0;
  let cadT = 0;
  let maxHr: number | null = null;
  for (let k = 1; k < seg.length; k++) {
    const dt = seg[k].t - seg[k - 1].t;
    if (dt <= 0) continue;
    if (seg[k].pace != null) movingS += dt;
    if (seg[k].hr != null) {
      hrW += seg[k].hr! * dt;
      hrT += dt;
      maxHr = Math.max(maxHr ?? 0, seg[k].hr!);
    }
    if (seg[k].cad != null && seg[k].pace != null) {
      cadW += seg[k].cad! * dt;
      cadT += dt;
    }
  }
  if (movingS === 0 && distanceM > 0) movingS = elapsedS; // no pace data: fall back to elapsed

  let gain: number | null = null;
  let loss: number | null = null;
  const alts = seg.map((p) => p.alt).filter((x): x is number => x != null);
  if (alts.length > 1) {
    gain = 0;
    loss = 0;
    let ref = alts[0];
    for (const e of alts) {
      if (e - ref >= 2) {
        gain += e - ref;
        ref = e;
      } else if (ref - e >= 2) {
        loss += ref - e;
        ref = e;
      }
    }
  }

  let hrDrift: number | null = null;
  const fifth = Math.floor(seg.length / 5);
  if (fifth >= 2) {
    const first = mean(seg.slice(0, fifth).map((p) => p.hr).filter((x): x is number => x != null));
    const last = mean(seg.slice(-fifth).map((p) => p.hr).filter((x): x is number => x != null));
    if (first != null && last != null) hrDrift = last - first;
  }

  return {
    startIdx: i0,
    endIdx: i1,
    distanceM,
    elapsedS,
    movingS,
    paceSPerKm: distanceM >= 50 ? (movingS / distanceM) * 1000 : null,
    avgHr: hrT ? hrW / hrT : null,
    maxHr,
    avgCadence: cadT ? cadW / cadT : null,
    elevGainM: gain,
    elevLossM: loss,
    hrDriftBpm: hrDrift,
  };
}

export interface LapLike {
  index: number;
  startT: number;
  endT: number;
  distanceM: number | null;
  timerS: number | null;
  avgSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  intensity: string | null;
}

export interface LapComparisonRow {
  index: number;
  paceSPerKm: number | null;
  /** Seconds per km slower (+) or faster (−) than the reference lap. */
  paceDelta: number | null;
  avgHr: number | null;
  hrDelta: number | null;
  avgCadence: number | null;
  distanceM: number | null;
  timerS: number | null;
}

export interface LapComparison {
  rows: LapComparisonRow[];
  reference: number;
  /** Only when ≥ 3 comparable laps: spread and fade of the reps. */
  consistency: {
    /** Coefficient of variation of pace, in %. */
    paceCvPct: number;
    fastest: number;
    slowest: number;
    /** Mean pace of the last third minus the first third, s/km (+ = faded). */
    fadeSPerKm: number;
    /** Mean HR of the last third minus the first third, bpm. */
    hrRiseBpm: number | null;
  } | null;
}

export const lapPace = (l: LapLike): number | null =>
  l.avgSpeed && l.avgSpeed > 0.5 ? 1000 / l.avgSpeed : l.distanceM && l.timerS && l.distanceM > 0 ? (l.timerS / l.distanceM) * 1000 : null;

export function compareLaps(laps: LapLike[]): LapComparison | null {
  if (laps.length < 2) return null;
  const ref = laps[0];
  const refPace = lapPace(ref);
  const rows = laps.map((l) => {
    const p = lapPace(l);
    return {
      index: l.index,
      paceSPerKm: p,
      paceDelta: p != null && refPace != null ? p - refPace : null,
      avgHr: l.avgHr,
      hrDelta: l.avgHr != null && ref.avgHr != null ? l.avgHr - ref.avgHr : null,
      avgCadence: l.avgCadence,
      distanceM: l.distanceM,
      timerS: l.timerS,
    };
  });

  let consistency: LapComparison["consistency"] = null;
  const paces = rows.map((r) => r.paceSPerKm).filter((p): p is number => p != null);
  if (paces.length >= 3 && paces.length === rows.length) {
    const m = mean(paces)!;
    const sd = Math.sqrt(paces.reduce((s, p) => s + (p - m) ** 2, 0) / paces.length);
    const third = Math.max(1, Math.floor(paces.length / 3));
    const hrs = rows.map((r) => r.avgHr);
    const hrFirst = mean(hrs.slice(0, third).filter((x): x is number => x != null));
    const hrLast = mean(hrs.slice(-third).filter((x): x is number => x != null));
    consistency = {
      paceCvPct: (sd / m) * 100,
      fastest: rows[paces.indexOf(Math.min(...paces))].index,
      slowest: rows[paces.indexOf(Math.max(...paces))].index,
      fadeSPerKm: mean(paces.slice(-third))! - mean(paces.slice(0, third))!,
      hrRiseBpm: hrFirst != null && hrLast != null ? hrLast - hrFirst : null,
    };
  }
  return { rows, reference: ref.index, consistency };
}

/**
 * Work laps of a structured session: "active" laps when the watch tagged intensity,
 * otherwise laps clearly faster than the run's median lap (interval reps).
 */
export function workLaps(laps: LapLike[]): number[] {
  if (laps.some((l) => l.intensity && l.intensity !== "active")) {
    return laps.filter((l) => (l.intensity ?? "active") === "active").map((l) => l.index);
  }
  const paced = laps.map((l) => ({ i: l.index, p: lapPace(l) })).filter((x): x is { i: number; p: number } => x.p != null);
  if (paced.length < 3) return [];
  const sorted = paced.map((x) => x.p).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const fast = paced.filter((x) => x.p < median * 0.92).map((x) => x.i);
  return fast.length >= 2 ? fast : [];
}

/** Points of one lap, with x re-based to metres (or seconds) from the lap start, for overlay charts. */
export function lapSeries(points: ChartPoint[], lap: { startT: number; endT: number }, by: "d" | "t" = "d") {
  const inLap = points.filter((p) => p.t >= lap.startT && p.t <= lap.endT);
  if (!inLap.length) return [];
  const x0 = by === "d" ? inLap[0].d * 1000 : inLap[0].t;
  return inLap.map((p) => ({ x: (by === "d" ? p.d * 1000 : p.t) - x0, pace: p.pace, hr: p.hr }));
}
