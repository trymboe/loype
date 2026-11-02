/**
 * Fitness estimate (`fitness@1`): a VO2max-equivalent (Daniels VDOT) with a
 * range and a confidence, built only from evidence in the last 90 days.
 *
 * Evidence, strongest first:
 *  1. Near-maximal performances: races, or best efforts ≥ 1.5 km run at
 *     ≥ 90 % of heart-rate reserve. VDOT from distance + time.
 *  2. The steady HR–speed relationship of ordinary runs (Swain: %HRR ≈ %VO2R),
 *     one reading per run. Each is noisy (heat, hills, fatigue, wrist HR), so
 *     we take a recency-weighted median and report the spread.
 * Every recorded best effort is a floor: you ran it, so the estimate is never
 * below what your fastest recent effort implies.
 *
 * The estimate is withheld when there are fewer than 3 usable readings.
 * A single great session moves the estimate only through the median, so one
 * outlier can't swing it (spec: don't over-react).
 */
import { addDaysIso, daysBetween } from "../../dates";
import type { Physiology } from "./physiology";
import type { RunRecord, RunScore } from "./scoring";
import { predictTimeS, trainingPaces, vdotFromPerformance, type PaceZone } from "./vdot";

export const WINDOW_DAYS = 90;
export const MIN_READINGS = 3;
/** Model error for a single HR-based reading, in VDOT points (assumed; literature reports SEE ≈ 3–5 ml/kg/min for submaximal methods). */
const HR_MODEL_SD = 3;
const RECENCY_HALF_LIFE_DAYS = 30;

export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  activityId: string;
  date: string;
  kind: "performance" | "hr_speed" | "floor";
  value: number;
  weight: number;
  detail: string;
}

export type FitnessEstimate =
  | {
      withheld: false;
      asOf: string;
      vdot: number;
      lower: number;
      upper: number;
      confidence: Confidence;
      method: "performance" | "hr_speed";
      evidence: Evidence[];
      notes: string[];
    }
  | { withheld: true; asOf: string; reason: string; evidence: Evidence[] };

export interface ScoredRun {
  run: RunRecord;
  score: RunScore;
}

const recencyWeight = (date: string, asOf: string) => Math.pow(0.5, daysBetween(date, asOf) / RECENCY_HALF_LIFE_DAYS);

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

export function estimateFitness(asOf: string, runs: ScoredRun[], p: Physiology): FitnessEstimate {
  const from = addDaysIso(asOf, -WINDOW_DAYS);
  const recent = runs.filter((r) => r.run.date > from && r.run.date <= asOf && r.run.usableForFitness);
  const evidence: Evidence[] = [];

  // performance evidence + floor
  let floor: Evidence | null = null;
  const nearMax: Evidence[] = [];
  for (const { run, score } of recent) {
    if (!run.paceReliable || !run.features) continue;
    for (const e of run.features.bestEfforts) {
      if (e.distanceM < 1500) continue;
      const v = vdotFromPerformance(e.distanceM, e.timeS);
      const label = `${fmtDist(e.distanceM)} in ${fmtTime(e.timeS)}`;
      if (!floor || v > floor.value) floor = { activityId: run.id, date: run.date, kind: "floor", value: r1(v), weight: 0, detail: label };
      const x = e.avgHr != null && p.maxHr && p.restHr ? (e.avgHr - p.restHr.value) / (p.maxHr.value - p.restHr.value) : null;
      const isRace = score.classification === "race";
      if (isRace || (x != null && x >= 0.9 && run.hrReliable)) {
        nearMax.push({
          activityId: run.id,
          date: run.date,
          kind: "performance",
          value: r1(v),
          weight: recencyWeight(run.date, asOf) * (isRace ? 1.5 : 1),
          detail: `${label}${isRace ? " (race)" : ` at ${Math.round(x! * 100)} % HR reserve`}`,
        });
      }
    }
  }
  // keep the best near-max effort per run
  const perRun = new Map<string, Evidence>();
  for (const e of nearMax) if (!perRun.has(e.activityId) || perRun.get(e.activityId)!.value < e.value) perRun.set(e.activityId, e);
  const perf = [...perRun.values()];

  const hr: Evidence[] = recent
    .filter((r) => r.score.vo2maxFromHr != null)
    .map(({ run, score }) => ({
      activityId: run.id,
      date: run.date,
      kind: "hr_speed" as const,
      value: score.vo2maxFromHr!,
      weight: recencyWeight(run.date, asOf) * Math.min(1, (run.features?.steady?.movingS ?? 0) / 2400),
      detail: `${fmtDist(run.distanceM ?? 0)} at ${Math.round((score.intensity ?? 0) * 100)} % HR reserve`,
    }));

  const notes: string[] = [];
  if (p.maxHr?.source === "observed") notes.push(`Uses max HR ${p.maxHr.value} bpm, the highest seen in your runs. If your real max is higher, this estimate is conservative. You can set it under More → Athlete profile.`);
  if (p.maxHr?.source === "age_formula") notes.push("Max HR comes from an age formula, which is often off by ±10 bpm. Set it under More → Athlete profile.");
  if (p.restHr?.source === "overnight_proxy") notes.push("Resting HR is approximated from your overnight average HR.");

  let est: { vdot: number; half: number; method: "performance" | "hr_speed"; confidence: Confidence } | null = null;
  if (perf.length >= 1) {
    const top = [...perf].sort((a, b) => b.value * b.weight - a.value * a.weight).slice(0, 3);
    const w = top.reduce((a, b) => a + b.weight, 0);
    const vdot = top.reduce((a, b) => a + b.value * b.weight, 0) / w;
    est = { vdot, half: top.length >= 2 ? 1.5 : 2.5, method: "performance", confidence: top.length >= 2 ? "high" : "medium" };
    evidence.push(...top);
  } else if (hr.length >= MIN_READINGS) {
    const vdot = weightedMedian(hr);
    const spread = mad(hr.map((h) => h.value));
    const se = Math.sqrt(spread ** 2 + HR_MODEL_SD ** 2) / Math.sqrt(Math.min(hr.length, 8));
    const half = Math.max(2, 1.96 * se + (p.maxHr?.source === "manual" ? 0 : 1));
    const confidence: Confidence = hr.length >= 6 && spread < 3 && p.maxHr?.source === "manual" ? "medium" : "low";
    est = { vdot, half, method: "hr_speed", confidence };
    evidence.push(...hr);
    notes.push(`Based on the heart rate–pace relationship in ${hr.length} steady runs, not on races. Heat, hills and wrist-HR errors add noise; a race or all-out time trial would sharpen it.`);
  }
  if (floor) evidence.push(floor);

  if (!est) {
    const reason = !p.maxHr || !p.restHr
      ? "Needs max and resting heart rate. Wear the watch overnight or enter them under More → Athlete profile."
      : `Not enough evidence in the last ${WINDOW_DAYS} days: needs ${MIN_READINGS} steady runs of 15+ minutes with reliable heart rate and GPS, or one race. Found ${hr.length}.`;
    return { withheld: true, asOf, reason, evidence };
  }
  let { vdot } = est;
  if (floor && floor.value > vdot) {
    notes.push(`Raised to ${r1(floor.value)} by your ${floor.detail} on ${floor.date}: you can't be slower than what you've already run.`);
    vdot = floor.value;
  }
  const lower = Math.max(floor?.value ?? 0, vdot - est.half);
  return { withheld: false, asOf, vdot: r1(vdot), lower: r1(lower), upper: r1(vdot + est.half), confidence: est.confidence, method: est.method, evidence, notes };
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
