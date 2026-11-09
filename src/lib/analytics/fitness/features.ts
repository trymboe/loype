/**
 * Per-run features extracted once from the stored streams (`features@2`).
 *
 * Everything here depends only on the recording, never on the athlete's
 * current max/resting HR or fitness. The fitness model (model.ts) turns these
 * features into load, zones and estimates, so a change in max HR re-scores
 * every run without re-reading every stream.
 */

export const FEATURES_VERSION = "features@2";

/** Length of the moving-time windows used for the per-run HR–speed relationship. */
export const SEGMENT_S = 60;

export const BEST_EFFORT_DISTANCES = [400, 1000, 1609.344, 3000, 5000, 10_000, 15_000, 21_097.5, 42_195] as const;

/** Warm-up skipped before measuring the steady HR/speed relationship. */
export const STEADY_SKIP_S = 300;

export interface StreamInput {
  t: number[];
  distance: (number | null)[] | null;
  hr: (number | null)[] | null;
  altitude: (number | null)[] | null;
  /** per-interval state: 'm' moving, 's' stopped, 'p' paused (length n-1) */
  motion_states: string | null;
}

export interface BestEffort {
  distanceM: number;
  timeS: number;
  /** elapsed seconds since activity start at which the effort began */
  startT: number;
  avgHr: number | null;
}

export interface HalfStats {
  movingS: number;
  distanceM: number;
  avgHr: number | null;
}

/**
 * One minute of moving time. Consecutive windows have consecutive `k`
 * (window k covers moving time k·60 … (k+1)·60 s); a gap in `k` means the
 * window had too little data to keep.
 */
export interface Segment {
  k: number;
  /** moving seconds and metres in the window */
  s: number;
  d: number;
  /** time-weighted mean HR and altitude, when recorded */
  hr: number | null;
  alt: number | null;
  /** seconds stopped or paused that fell inside this window */
  stopS: number;
}

export interface RunFeatures {
  version: typeof FEATURES_VERSION;
  timerS: number;
  movingS: number;
  distanceM: number;
  /** Seconds spent at each whole bpm while the timer ran: hrHist[k] = seconds at (hrHistOffset + k) bpm. */
  hrHistOffset: number;
  hrHist: number[];
  /** Highest 20-second rolling mean HR, robust to single-sample spikes and to Garmin smart recording (samples every 1–8 s). */
  maxSustainedHr: number | null;
  /** Steady part of the run (after the first STEADY_SKIP_S of moving time). */
  steady: { movingS: number; distanceM: number; avgHr: number | null; gainPerKm: number | null } | null;
  /** First and second half of the steady part, by moving time, for HR decoupling. */
  halves: [HalfStats, HalfStats] | null;
  /** Coefficient of variation of 60-s moving speed; high = variable pacing. */
  speedCv: number | null;
  /** Count of distinct fast bouts (≥ 30 s at > 115 % of the run's median speed). */
  fastBouts: number;
  bestEfforts: BestEffort[];
  /** Minute-by-minute speed, HR and altitude (moving time), for the HR–speed VO2max reading. */
  segments: Segment[];
}

const isMoving = (s: StreamInput, i: number) => (s.motion_states?.[i - 1] ?? "m") === "m";
const isRunningTimer = (s: StreamInput, i: number) => (s.motion_states?.[i - 1] ?? "m") !== "p";

export function extractFeatures(s: StreamInput): RunFeatures {
  const n = s.t.length;
  const dist = s.distance ?? [];
  const hr = s.hr ?? [];
  const alt = s.altitude ?? [];

  // cumulative timer time (excluding pauses) and moving time per sample
  const timer = new Array<number>(n).fill(0);
  const moving = new Array<number>(n).fill(0);
  const hrHist = new Map<number, number>();
  let maxHrSample = 0;
  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, s.t[i] - s.t[i - 1]);
    const run = isRunningTimer(s, i);
    timer[i] = timer[i - 1] + (run ? dt : 0);
    moving[i] = moving[i - 1] + (isMoving(s, i) ? dt : 0);
    const h = hr[i];
    if (run && h != null && h >= 30 && h <= 230 && dt <= 30) {
      const b = Math.round(h);
      hrHist.set(b, (hrHist.get(b) ?? 0) + dt);
      maxHrSample = Math.max(maxHrSample, b);
    }
  }
  const bins = [...hrHist.keys()];
  const hrHistOffset = bins.length ? Math.min(...bins) : 0;
  const hist = bins.length ? new Array(Math.max(...bins) - hrHistOffset + 1).fill(0) : [];
  for (const [b, sec] of hrHist) hist[b - hrHistOffset] = Math.round(sec * 10) / 10;

  const lastDist = lastNumber(dist) ?? 0;

  return {
    version: FEATURES_VERSION,
    timerS: timer[n - 1] ?? 0,
    movingS: moving[n - 1] ?? 0,
    distanceM: lastDist,
    hrHistOffset,
    hrHist: hist,
    maxSustainedHr: rollingMaxMean(s.t, hr, 20),
    ...steadyStats(s, moving, dist, hr, alt),
    ...pacingStats(s, moving, dist),
    bestEfforts: bestEfforts(s.t, timer, dist, hr),
    segments: segments(s, moving, dist, hr, alt),
  };
}

function lastNumber(a: (number | null)[]): number | null {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i];
  return null;
}

function rollingMaxMean(t: number[], v: (number | null)[], windowS: number): number | null {
  let best: number | null = null;
  let lo = 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < t.length; i++) {
    if (v[i] != null) {
      sum += v[i]!;
      cnt++;
    }
    while (t[i] - t[lo] > windowS) {
      if (v[lo] != null) {
        sum -= v[lo]!;
        cnt--;
      }
      lo++;
    }
    if (t[i] - t[lo] >= windowS * 0.75 && cnt >= 3) {
      const m = sum / cnt;
      if (best == null || m > best) best = m;
    }
  }
  return best == null ? null : Math.round(best * 10) / 10;
}

function steadyStats(
  s: StreamInput,
  moving: number[],
  dist: (number | null)[],
  hr: (number | null)[],
  alt: (number | null)[],
): Pick<RunFeatures, "steady" | "halves"> {
  const n = s.t.length;
  const total = moving[n - 1] ?? 0;
  if (total - STEADY_SKIP_S < 300) return { steady: null, halves: null };
  const mid = STEADY_SKIP_S + (total - STEADY_SKIP_S) / 2;
  const acc = () => ({ movingS: 0, distanceM: 0, hrSum: 0, hrS: 0 });
  const all = acc();
  const half = [acc(), acc()];
  let gain = 0;
  let lastAlt: number | null = null;
  for (let i = 1; i < n; i++) {
    if (!isMoving(s, i) || moving[i] <= STEADY_SKIP_S) continue;
    const dt = s.t[i] - s.t[i - 1];
    const d0 = dist[i - 1];
    const d1 = dist[i];
    if (d0 == null || d1 == null || dt <= 0 || dt > 30) continue;
    const dd = Math.max(0, d1 - d0);
    const h = hr[i];
    for (const a of [all, half[moving[i] <= mid ? 0 : 1]]) {
      a.movingS += dt;
      a.distanceM += dd;
      if (h != null) {
        a.hrSum += h * dt;
        a.hrS += dt;
      }
    }
    const al = alt[i];
    if (al != null) {
      if (lastAlt == null) lastAlt = al;
      else if (al - lastAlt >= 2) {
        gain += al - lastAlt;
        lastAlt = al;
      } else if (lastAlt - al >= 2) lastAlt = al;
    }
  }
  const avgHr = (a: ReturnType<typeof acc>) => (a.hrS >= a.movingS * 0.8 && a.hrS > 0 ? Math.round((a.hrSum / a.hrS) * 10) / 10 : null);
  const hasAlt = alt.some((v) => v != null);
  return {
    steady: {
      movingS: all.movingS,
      distanceM: all.distanceM,
      avgHr: avgHr(all),
      gainPerKm: hasAlt && all.distanceM > 0 ? Math.round((gain / (all.distanceM / 1000)) * 10) / 10 : null,
    },
    halves: [
      { movingS: half[0].movingS, distanceM: half[0].distanceM, avgHr: avgHr(half[0]) },
      { movingS: half[1].movingS, distanceM: half[1].distanceM, avgHr: avgHr(half[1]) },
    ],
  };
}

/** One-minute moving-time windows: distance, mean HR, mean altitude, and stopped time. */
export function segments(s: StreamInput, moving: number[], dist: (number | null)[], hr: (number | null)[], alt: (number | null)[]): Segment[] {
  const n = s.t.length;
  const acc = new Map<number, { s: number; d: number; hrSum: number; hrS: number; altSum: number; altS: number; stopS: number }>();
  const get = (k: number) => {
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { s: 0, d: 0, hrSum: 0, hrS: 0, altSum: 0, altS: 0, stopS: 0 }));
    return a;
  };
  for (let i = 1; i < n; i++) {
    const dt = s.t[i] - s.t[i - 1];
    if (dt <= 0) continue;
    const k = Math.floor(moving[i - 1] / SEGMENT_S);
    if (!isMoving(s, i) || dt > 30) {
      get(k).stopS += dt;
      continue;
    }
    const d0 = dist[i - 1];
    const d1 = dist[i];
    if (d0 == null || d1 == null) continue;
    const a = get(k);
    a.s += dt;
    a.d += Math.max(0, d1 - d0);
    const h = hr[i];
    if (h != null && h >= 30 && h <= 230) {
      a.hrSum += h * dt;
      a.hrS += dt;
    }
    const al = alt[i];
    if (al != null) {
      a.altSum += al * dt;
      a.altS += dt;
    }
  }
  return [...acc.entries()]
    .filter(([, a]) => a.s >= SEGMENT_S / 2)
    .sort((x, y) => x[0] - y[0])
    .map(([k, a]) => ({
      k,
      s: Math.round(a.s * 10) / 10,
      d: Math.round(a.d * 10) / 10,
      hr: a.hrS >= a.s * 0.8 ? Math.round((a.hrSum / a.hrS) * 10) / 10 : null,
      alt: a.altS >= a.s * 0.8 ? Math.round((a.altSum / a.altS) * 10) / 10 : null,
      stopS: Math.round(a.stopS),
    }));
}

/** 60-s moving-speed variability and fast-bout count (interval detection). */
function pacingStats(s: StreamInput, moving: number[], dist: (number | null)[]): Pick<RunFeatures, "speedCv" | "fastBouts"> {
  const n = s.t.length;
  // resample distance onto a moving-time grid every 10 s
  const grid: number[] = [];
  let k = 0;
  for (let mt = 0; mt <= (moving[n - 1] ?? 0); mt += 10) {
    while (k + 1 < n && moving[k + 1] < mt) k++;
    const d = dist[Math.min(n - 1, k + 1)] ?? dist[k];
    if (d == null) return { speedCv: null, fastBouts: 0 };
    grid.push(d);
  }
  const speeds = (w: number) => {
    const out: number[] = [];
    for (let i = w; i < grid.length; i++) out.push((grid[i] - grid[i - w]) / (w * 10));
    return out;
  };
  const v60 = speeds(6);
  if (v60.length < 6) return { speedCv: null, fastBouts: 0 };
  const mean = v60.reduce((a, b) => a + b, 0) / v60.length;
  const sd = Math.sqrt(v60.reduce((a, b) => a + (b - mean) ** 2, 0) / v60.length);
  const v30 = speeds(3);
  const sorted = [...v30].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bouts = 0;
  let inBout = false;
  for (const v of v30) {
    if (!inBout && v > median * 1.15) {
      inBout = true;
      bouts++;
    } else if (inBout && v < median * 1.02) inBout = false;
  }
  return { speedCv: mean > 0 ? Math.round((sd / mean) * 1000) / 1000 : null, fastBouts: bouts };
}

/**
 * Fastest timer-time segment covering each standard distance (pauses
 * excluded, stops included). Start points are interpolated between samples.
 */
export function bestEfforts(t: number[], timer: number[], dist: (number | null)[], hr: (number | null)[]): BestEffort[] {
  const idx: number[] = [];
  for (let i = 0; i < t.length; i++) if (dist[i] != null) idx.push(i);
  if (idx.length < 2) return [];
  const D = idx.map((i) => dist[i]!);
  const T = idx.map((i) => timer[i]);
  const total = D[D.length - 1] - D[0];
  const out: BestEffort[] = [];
  for (const target of BEST_EFFORT_DISTANCES) {
    if (target > total) break;
    let best: { time: number; j: number; i: number; startTimer: number } | null = null;
    let j = 0;
    for (let i = 1; i < D.length; i++) {
      const startD = D[i] - target;
      if (startD < D[0]) continue;
      while (j + 1 < i && D[j + 1] <= startD) j++;
      const span = D[j + 1] - D[j];
      const frac = span > 0 ? (startD - D[j]) / span : 0;
      const startTimer = T[j] + frac * (T[j + 1] - T[j]);
      const time = T[i] - startTimer;
      if (time > 0 && (best == null || time < best.time)) best = { time, j, i, startTimer };
    }
    if (!best) continue;
    let hrSum = 0;
    let hrN = 0;
    for (let k = idx[best.j]; k <= idx[best.i]; k++) {
      if (hr[k] != null) {
        hrSum += hr[k]!;
        hrN++;
      }
    }
    const span = idx[best.i] - idx[best.j] + 1;
    out.push({
      distanceM: target,
      timeS: Math.round(best.time * 10) / 10,
      startT: t[idx[best.j]],
      avgHr: hrN >= span * 0.8 ? Math.round((hrSum / hrN) * 10) / 10 : null,
    });
  }
  return out;
}
