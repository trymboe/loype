/**
 * Fitness estimate (`fitness@2`): a VO2max-equivalent (Daniels VDOT) with a
 * range and a confidence, tracked from every run, the way watches do it.
 *
 *  1. Every outdoor run with reliable HR and GPS gives a reading from its
 *     minute-by-minute HR–speed relationship (scoring.ts, hrSpeedReading).
 *     Each is noisy (heat, hills, fatigue, wrist HR).
 *  2. The level is a recency-weighted mean of the readings from the last
 *     6 weeks (21-day half-life), after dropping outliers more than 2.5
 *     robust SDs from the weighted median, so one odd run can't swing it but
 *     a real trend shows within a few weeks.
 *  3. Races and near-maximal efforts (best efforts ≥ 1.5 km at ≥ 90 % of HR
 *     reserve, planned time trials) calibrate it to you: the gap between the
 *     performance and the HR level around that date becomes a personal
 *     offset (decaying over ~6 months, shrunk towards 0 with little
 *     evidence). Watches calibrate the same way, since HR-based estimates
 *     carry an individual bias (running economy, max HR error).
 *  4. A best effort in the last 4 weeks is a floor: you ran it.
 * Without HR readings, recent near-maximal efforts are used directly.
 */
import { addDaysIso, daysBetween } from "../../dates";
import type { Physiology } from "./physiology";
import type { RunRecord, RunScore } from "./scoring";
import { predictTimeS, trainingPaces, vdotFromPerformance, type PaceZone } from "./vdot";

export const WINDOW_DAYS = 42;
/** Wider window used when the last 6 weeks hold too few readings (lower confidence). */
export const FALLBACK_WINDOW_DAYS = 90;
export const PERFORMANCE_WINDOW_DAYS = 90;
export const CALIBRATION_WINDOW_DAYS = 365;
export const FLOOR_WINDOW_DAYS = 28;
export const MIN_READINGS = 3;
/** Model error for a single HR-based reading, in VDOT points (assumed; literature reports SEE ≈ 3–5 ml/kg/min for submaximal methods). */
const HR_MODEL_SD = 3;
const RECENCY_HALF_LIFE_DAYS = 21;
const CALIBRATION_HALF_LIFE_DAYS = 180;
/** Prior weight (in performances) pulling the personal offset towards 0. */
const CALIBRATION_PRIOR = 0.5;
const MAX_OFFSET = 6;
/** Qualifying minutes for a reading to count fully. */
const FULL_WEIGHT_MINUTES = 20;

export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  activityId: string;
  date: string;
  kind: "performance" | "hr_speed" | "floor";
  value: number;
  weight: number;
  detail: string;
}

export type EstimateMethod = "performance" | "hr_speed" | "hr_calibrated";

export type FitnessEstimate =
  | {
      withheld: false;
      asOf: string;
      vdot: number;
      lower: number;
      upper: number;
      confidence: Confidence;
      method: EstimateMethod;
      /** HR-based level before the personal offset, and the offset itself (fitness@2) */
      hrLevel?: number | null;
      offset?: number | null;
      readings?: number;
      evidence: Evidence[];
      notes: string[];
    }
  | { withheld: true; asOf: string; reason: string; evidence: Evidence[] };

export interface ScoredRun {
  run: RunRecord;
  score: RunScore;
}

const halfLife = (days: number, h: number) => Math.pow(0.5, days / h);
const recencyWeight = (date: string, asOf: string) => halfLife(daysBetween(date, asOf), 30);

function weightedMedian(items: { value: number; weight: number }[]): number {
  const s = [...items].sort((a, b) => a.value - b.value);
  const total = s.reduce((a, b) => a + b.weight, 0);
  let acc = 0;
  for (const i of s) {
    acc += i.weight;
    if (acc >= total / 2) return i.value;
  }
  return s[s.length - 1].value;
}

function mad(values: number[]): number {
  const med = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const dev = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * dev[Math.floor(dev.length / 2)];
}

export interface HrLevel {
  value: number;
  n: number;
  /** effective number of readings after weighting */
  nEff: number;
  spread: number;
  used: Evidence[];
}

/**
 * Robust, recency-weighted level of the HR readings around `center`. With
 * `pastOnly`, only readings on or before `center` (the estimate for a day);
 * otherwise readings on both sides (the level at a past performance).
 */
export function hrLevel(readings: Evidence[], center: string, windowDays: number, pastOnly: boolean): HrLevel | null {
  const pool = readings
    .filter((r) => {
      const age = daysBetween(r.date, center);
      return pastOnly ? age >= 0 && age < windowDays : Math.abs(age) < windowDays;
    })
    .map((r) => ({ ...r, weight: r.weight * halfLife(Math.abs(daysBetween(r.date, center)), RECENCY_HALF_LIFE_DAYS) }));
  if (pool.length < (pastOnly ? MIN_READINGS : 2)) return null;
  const med = weightedMedian(pool);
  const spread = mad(pool.map((r) => r.value));
  const cut = Math.max(3, 2.5 * spread);
  const kept = pool.filter((r) => Math.abs(r.value - med) <= cut);
  const w = kept.reduce((a, b) => a + b.weight, 0);
  const value = kept.reduce((a, b) => a + b.value * b.weight, 0) / w;
  const nEff = w ** 2 / kept.reduce((a, b) => a + b.weight ** 2, 0);
  return { value, n: kept.length, nEff, spread, used: kept };
}

/** Near-maximal performances in [from, to]: races, planned time trials, or best efforts ≥ 1.5 km at ≥ 90 % HRR. Best one per run. */
function performances(runs: ScoredRun[], from: string, to: string, asOf: string, p: Physiology): Evidence[] {
  const perRun = new Map<string, Evidence>();
  for (const { run, score } of runs) {
    if (run.date <= from || run.date > to || !run.paceReliable || !run.features) continue;
    const isRace = score.classification === "race";
    for (const e of run.features.bestEfforts) {
      if (e.distanceM < 1500) continue;
      const x = e.avgHr != null && p.maxHr && p.restHr ? (e.avgHr - p.restHr.value) / (p.maxHr.value - p.restHr.value) : null;
      if (!isRace && !(x != null && x >= 0.9 && run.hrReliable)) continue;
      const v = vdotFromPerformance(e.distanceM, e.timeS);
      const ev: Evidence = {
        activityId: run.id,
        date: run.date,
        kind: "performance",
        value: r1(v),
        weight: recencyWeight(run.date, asOf) * (isRace ? 1.5 : 1),
        detail: `${fmtDist(e.distanceM)} in ${fmtTime(e.timeS)}${isRace ? " (race)" : ` at ${Math.round(x! * 100)} % HR reserve`}`,
      };
      const prev = perRun.get(run.id);
      if (!prev || prev.value < ev.value) perRun.set(run.id, ev);
    }
  }
  return [...perRun.values()];
}

export function estimateFitness(asOf: string, runs: ScoredRun[], p: Physiology): FitnessEstimate {
  const usable = runs.filter((r) => r.run.date <= asOf && r.run.usableForFitness);
  const evidence: Evidence[] = [];

  // per-run HR readings (all of them up to asOf; the windows below pick what counts)
  const readings: Evidence[] = usable
    .filter((r) => r.score.vo2maxFromHr != null)
    .map(({ run, score }) => ({
      activityId: run.id,
      date: run.date,
      kind: "hr_speed" as const,
      value: score.vo2maxFromHr!,
      weight: Math.min(1, (score.vo2maxMinutes ?? FULL_WEIGHT_MINUTES) / FULL_WEIGHT_MINUTES),
      detail: `${fmtDist(run.distanceM ?? 0)}, ${score.vo2maxMinutes ?? "?"} steady min at ${Math.round((score.intensity ?? 0) * 100)} % HR reserve`,
    }));

  // floor: the best effort ≥ 1.5 km in the last 4 weeks
  let floor: Evidence | null = null;
  const floorFrom = addDaysIso(asOf, -FLOOR_WINDOW_DAYS);
  for (const { run } of usable) {
    if (run.date <= floorFrom || !run.paceReliable || !run.features) continue;
    for (const e of run.features.bestEfforts) {
      if (e.distanceM < 1500) continue;
      const v = vdotFromPerformance(e.distanceM, e.timeS);
      if (!floor || v > floor.value) floor = { activityId: run.id, date: run.date, kind: "floor", value: r1(v), weight: 0, detail: `${fmtDist(e.distanceM)} in ${fmtTime(e.timeS)}` };
    }
  }

  const notes: string[] = [];
  if (p.maxHr?.source === "observed") notes.push(`Uses max HR ${p.maxHr.value} bpm, the highest seen in your runs. If your real max is higher, this estimate is conservative. You can set it under More → Athlete profile.`);
  if (p.maxHr?.source === "age_formula") notes.push("Max HR comes from an age formula, which is often off by ±10 bpm. Set it under More → Athlete profile.");
  if (p.restHr?.source === "overnight_proxy") notes.push("Resting HR is approximated from your overnight average HR.");

  let est: { vdot: number; half: number; method: EstimateMethod; confidence: Confidence; hrLevel: number | null; offset: number | null; readings: number } | null = null;

  let level = hrLevel(readings, asOf, WINDOW_DAYS, true);
  let wide = false;
  if (!level) {
    level = hrLevel(readings, asOf, FALLBACK_WINDOW_DAYS, true);
    wide = level != null;
  }

  if (level) {
    // personal calibration from performances in the last year
    const perfs = performances(usable, addDaysIso(asOf, -CALIBRATION_WINDOW_DAYS), asOf, asOf, p);
    let wSum = 0;
    let dSum = 0;
    const calib: Evidence[] = [];
    for (const perf of perfs) {
      const around = hrLevel(
        readings.filter((r) => r.date <= asOf),
        perf.date,
        28,
        false,
      );
      if (!around) continue;
      const w = halfLife(daysBetween(perf.date, asOf), CALIBRATION_HALF_LIFE_DAYS) * (perf.detail.includes("(race)") ? 1.5 : 1);
      wSum += w;
      dSum += w * (perf.value - around.value);
      calib.push({ ...perf, weight: w, detail: `${perf.detail}; HR level then ${r1(around.value)}` });
    }
    const offset = calib.length ? Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, dSum / (wSum + CALIBRATION_PRIOR))) : 0;
    const calibrated = calib.length > 0;
    const se = Math.sqrt(level.spread ** 2 + HR_MODEL_SD ** 2) / Math.sqrt(Math.max(1, Math.min(level.nEff, 10)));
    const half = Math.max(1.5, 1.96 * se + (calibrated ? 0.5 : 1.5) + (p.maxHr?.source === "manual" ? 0 : 1) + (wide ? 1 : 0));
    const solid = !wide && level.n >= 6 && level.spread < 3 && p.maxHr?.source === "manual";
    const confidence: Confidence = solid && calibrated ? "high" : solid || (calibrated && !wide) ? "medium" : "low";
    est = { vdot: level.value + offset, half, method: calibrated ? "hr_calibrated" : "hr_speed", confidence, hrLevel: r1(level.value), offset: calibrated ? r1(offset) : null, readings: level.n };
    evidence.push(...[...level.used].sort((a, b) => b.date.localeCompare(a.date)), ...calib);
    notes.push(
      `Tracked from the heart rate–pace relationship in ${level.n} runs from the last ${wide ? FALLBACK_WINDOW_DAYS : WINDOW_DAYS} days, newer runs counting more. Heat, altitude, hills and wrist-HR errors add noise to single runs.`,
    );
    if (calibrated)
      notes.push(
        `Calibrated to you with ${calib.length === 1 ? "a hard effort" : `${calib.length} hard efforts`}: ${offset >= 0 ? "+" : ""}${r1(offset)} on top of the heart-rate level of ${r1(level.value)}.`,
      );
    else notes.push("Not yet calibrated with a race or all-out time trial; one would anchor the level.");
  } else {
    const perf = performances(usable, addDaysIso(asOf, -PERFORMANCE_WINDOW_DAYS), asOf, asOf, p);
    if (perf.length >= 1) {
      const top = [...perf].sort((a, b) => b.value * b.weight - a.value * a.weight).slice(0, 3);
      const w = top.reduce((a, b) => a + b.weight, 0);
      const vdot = top.reduce((a, b) => a + b.value * b.weight, 0) / w;
      est = { vdot, half: top.length >= 2 ? 1.5 : 2.5, method: "performance", confidence: top.length >= 2 ? "high" : "medium", hrLevel: null, offset: null, readings: 0 };
      evidence.push(...top);
    }
  }
  if (floor) evidence.push(floor);

  if (!est) {
    const reason = !p.maxHr || !p.restHr
      ? "Needs max and resting heart rate. Wear the watch overnight or enter them under More → Athlete profile."
      : `Not enough evidence in the last ${FALLBACK_WINDOW_DAYS} days: needs ${MIN_READINGS} outdoor runs with reliable heart rate and GPS and at least ${6} steady minutes each, or one race. Found ${readings.filter((r) => daysBetween(r.date, asOf) < FALLBACK_WINDOW_DAYS).length}.`;
    return { withheld: true, asOf, reason, evidence };
  }
  let { vdot } = est;
  if (floor && floor.value > vdot) {
    notes.push(`Raised to ${r1(floor.value)} by your ${floor.detail} on ${floor.date}: you can't be slower than what you've just run.`);
    vdot = floor.value;
  }
  const lower = Math.max(floor?.value ?? 0, vdot - est.half);
  return {
    withheld: false,
    asOf,
    vdot: r1(vdot),
    lower: r1(lower),
    upper: r1(vdot + est.half),
    confidence: est.confidence,
    method: est.method,
    hrLevel: est.hrLevel,
    offset: est.offset,
    readings: est.readings,
    evidence,
    notes,
  };
}

export interface RacePrediction {
  key: "5k" | "10k" | "half" | "marathon";
  label: string;
  distanceM: number;
  timeS: number;
  fastS: number;
  slowS: number;
  confidence: Confidence;
  note: string | null;
}

const RACES: { key: RacePrediction["key"]; label: string; distanceM: number }[] = [
  { key: "5k", label: "5 km", distanceM: 5000 },
  { key: "10k", label: "10 km", distanceM: 10_000 },
  { key: "half", label: "Half marathon", distanceM: 21_097.5 },
  { key: "marathon", label: "Marathon", distanceM: 42_195 },
];

/**
 * Endurance correction: VDOT assumes you've trained for the distance. When
 * the race is much longer than your longest recent run, predictions are
 * slowed by up to 12 % (heuristic, documented in docs/ANALYTICS.md).
 */
export function endurancePenalty(distanceM: number, longestRecentM: number): number {
  if (longestRecentM <= 0) return 0.12;
  const ratio = distanceM / longestRecentM;
  if (ratio <= 1.5) return 0;
  return Math.min(0.12, 0.05 * Math.log2(ratio / 1.5));
}

export function racePredictions(est: Extract<FitnessEstimate, { withheld: false }>, longestRecentM: number): RacePrediction[] {
  const rank: Confidence[] = ["low", "medium", "high"];
  return RACES.map((r) => {
    const pen = endurancePenalty(r.distanceM, longestRecentM);
    const t = (v: number) => predictTimeS(v, r.distanceM) * (1 + pen);
    const conf = pen > 0 ? rank[Math.max(0, rank.indexOf(est.confidence) - (pen >= 0.06 ? 2 : 1))] : est.confidence;
    return {
      ...r,
      timeS: Math.round(t(est.vdot)),
      fastS: Math.round(t(est.upper)),
      slowS: Math.round(t(est.lower)),
      confidence: conf,
      note: pen > 0 ? `Slowed ${Math.round(pen * 100)} %: your longest run in the last 8 weeks is ${fmtDist(longestRecentM)}` : null,
    };
  });
}

export interface ThresholdEstimate {
  paceSPerKm: number;
  paceRange: [number, number];
  hr: number | null;
  hrNote: string | null;
}

export function thresholdFrom(est: Extract<FitnessEstimate, { withheld: false }>, p: Physiology): ThresholdEstimate {
  const t = trainingPaces(est.vdot).find((z) => z.key === "threshold")!;
  const lo = trainingPaces(est.lower).find((z) => z.key === "threshold")!;
  const hi = trainingPaces(est.upper).find((z) => z.key === "threshold")!;
  const hr = p.maxHr && p.restHr ? Math.round(p.restHr.value + 0.88 * (p.maxHr.value - p.restHr.value)) : null;
  return {
    paceSPerKm: Math.round((t.fastSPerKm + t.slowSPerKm) / 2),
    paceRange: [Math.round(hi.fastSPerKm), Math.round(lo.slowSPerKm)],
    hr,
    hrNote: hr ? "88 % of heart-rate reserve (Karvonen); a lab or field threshold test would pin it down" : null,
  };
}

export function paceZones(est: Extract<FitnessEstimate, { withheld: false }>): PaceZone[] {
  return trainingPaces(est.vdot);
}

export interface EfficiencyPoint {
  activityId: string;
  date: string;
  ef: number;
  decouplingPct: number | null;
}

export interface EfficiencyTrend {
  points: EfficiencyPoint[];
  /** % change per 30 days (Theil–Sen slope relative to the median), when supported */
  changePer30dPct: number | null;
  spanDays: number;
}

/** Aerobic efficiency on comparable runs: easy, long and steady runs only. */
export function efficiencyTrend(asOf: string, runs: ScoredRun[], windowDays = 120): EfficiencyTrend {
  const from = addDaysIso(asOf, -windowDays);
  const points = runs
    .filter((r) => r.run.date > from && r.run.date <= asOf && r.score.ef != null && ["easy", "long", "steady", "recovery"].includes(r.score.classification))
    .map((r) => ({ activityId: r.run.id, date: r.run.date, ef: r.score.ef!, decouplingPct: r.score.decouplingPct }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const spanDays = points.length ? daysBetween(points[0].date, points[points.length - 1].date) : 0;
  if (points.length < 5 || spanDays < 21) return { points, changePer30dPct: null, spanDays };
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dd = daysBetween(points[i].date, points[j].date);
      if (dd > 0) slopes.push((points[j].ef - points[i].ef) / dd);
    }
  slopes.sort((a, b) => a - b);
  const slope = slopes[Math.floor(slopes.length / 2)];
  const med = [...points.map((p) => p.ef)].sort((a, b) => a - b)[Math.floor(points.length / 2)];
  return { points, changePer30dPct: Math.round(((slope * 30) / med) * 1000) / 10, spanDays };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
export function fmtDist(m: number): string {
  if (Math.abs(m - 1609.344) < 1) return "1 mile";
  if (Math.abs(m - 21_097.5) < 1) return "half marathon";
  if (Math.abs(m - 42_195) < 1) return "marathon";
  return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${Math.round(m)} m`;
}
export function fmtTime(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
