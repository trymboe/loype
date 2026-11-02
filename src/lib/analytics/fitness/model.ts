/**
 * Runs the whole fitness model for one athlete as of a date. Pure: all inputs
 * are passed in, nothing is read or written here. Only data dated on or
 * before `asOf` is used, so the same function produces honest retrospective
 * snapshots ("what the model would have said then").
 */
import { addDaysIso, weekStart } from "../../dates";
import type { BestEffort } from "./features";
import { BEST_EFFORT_DISTANCES } from "./features";
import {
  efficiencyTrend,
  estimateFitness,
  paceZones,
  racePredictions,
  thresholdFrom,
  type EfficiencyTrend,
  type FitnessEstimate,
  type RacePrediction,
  type ScoredRun,
  type ThresholdEstimate,
} from "./estimate";
import { loadSeries, rampRate, type LoadDay } from "./load";
import { derivePhysiology, hrZones, type HrZone, type Physiology, type ProfileInput, type WellnessPoint } from "./physiology";
import { scoreRun, trimpFromAverage, type RunRecord } from "./scoring";
import type { PaceZone } from "./vdot";

export interface OtherActivity {
  id: string;
  date: string;
  type: string;
  durationS: number | null;
  avgHr: number | null;
}

export interface ModelInput {
  asOf: string;
  profile: ProfileInput | null;
  runs: RunRecord[];
  others: OtherActivity[];
  wellness: WellnessPoint[];
}

export interface BestEffortRecord extends BestEffort {
  activityId: string;
  date: string;
}

export interface ModelOutput {
  asOf: string;
  physiology: Physiology;
  hrZones: HrZone[] | null;
  scored: ScoredRun[];
  otherLoads: { id: string; date: string; type: string; trimp: number | null }[];
  load: LoadDay[];
  rampRate: number | null;
  estimate: FitnessEstimate;
  predictions: RacePrediction[] | null;
  threshold: ThresholdEstimate | null;
  paceZones: PaceZone[] | null;
  efficiency: EfficiencyTrend;
  bestEfforts: { allTime: BestEffortRecord[]; last90: BestEffortRecord[] };
  longestRecentM: number;
}

function medianMovingBefore(runs: RunRecord[], date: string): number | null {
  const from = addDaysIso(date, -56);
  const v = runs.filter((r) => r.date >= from && r.date < date && r.movingS).map((r) => r.movingS!).sort((a, b) => a - b);
  return v.length >= 3 ? v[Math.floor(v.length / 2)] : null;
}

export function runModel(input: ModelInput): ModelOutput {
  const { asOf } = input;
  const runs = input.runs.filter((r) => r.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const physiology = derivePhysiology(
    asOf,
    input.profile,
    runs.map((r) => ({ activityId: r.id, date: r.date, maxSustainedHr: r.features?.maxSustainedHr ?? null, hrReliable: r.hrReliable })),
    input.wellness,
  );

  // pass 1 without a VDOT (HR-based intensity only), pass 2 lets pace stand in when HR is unreliable
  const score = (vdot: number | null): ScoredRun[] =>
    runs.map((run) => ({ run, score: scoreRun(run, physiology, { vdot, medianRecentMovingS: medianMovingBefore(runs, run.date) }) }));
  let scored = score(null);
  let estimate = estimateFitness(asOf, scored, physiology);
  if (!estimate.withheld) {
    scored = score(estimate.vdot);
    estimate = estimateFitness(asOf, scored, physiology);
  }

  const others = input.others.filter((o) => o.date <= asOf);
  const otherLoads = others.map((o) => ({
    id: o.id,
    date: o.date,
    type: o.type,
    trimp: o.durationS && o.avgHr ? trimpFromAverage(o.durationS, o.avgHr, physiology) : null,
  }));
  const firstDate = [...runs.map((r) => r.date), ...others.map((o) => o.date)].sort()[0] ?? asOf;
  const load = loadSeries(
    [
      ...scored.filter((s) => s.score.trimp != null).map((s) => ({ date: s.run.date, trimp: s.score.trimp!, kind: "run" as const })),
      ...otherLoads.filter((o) => o.trimp != null).map((o) => ({ date: o.date, trimp: o.trimp!, kind: "other" as const })),
    ],
    firstDate,
    asOf,
  );

  const eightWeeksAgo = addDaysIso(asOf, -56);
  const longestRecentM = Math.max(0, ...runs.filter((r) => r.date > eightWeeksAgo).map((r) => r.distanceM ?? 0));

  return {
    asOf,
    physiology,
    hrZones: hrZones(physiology),
    scored,
    otherLoads,
    load,
    rampRate: rampRate(load),
    estimate,
    predictions: estimate.withheld ? null : racePredictions(estimate, longestRecentM),
    threshold: estimate.withheld ? null : thresholdFrom(estimate, physiology),
    paceZones: estimate.withheld ? null : paceZones(estimate),
    efficiency: efficiencyTrend(asOf, scored),
    bestEfforts: collectBestEfforts(runs, asOf),
    longestRecentM,
  };
}

function collectBestEfforts(runs: RunRecord[], asOf: string): ModelOutput["bestEfforts"] {
  const from90 = addDaysIso(asOf, -90);
  const best = (pool: RunRecord[]) =>
    BEST_EFFORT_DISTANCES.map((d) => {
      let top: BestEffortRecord | null = null;
      for (const r of pool) {
        if (!r.paceReliable || !r.features) continue;
        const e = r.features.bestEfforts.find((x) => x.distanceM === d);
        if (e && (!top || e.timeS < top.timeS)) top = { ...e, activityId: r.id, date: r.date };
      }
      return top;
    }).filter((x): x is BestEffortRecord => x != null);
  return { allTime: best(runs), last90: best(runs.filter((r) => r.date > from90)) };
}

export interface Snapshot {
  asOf: string;
  metric: string;
  value: number | null;
  lower: number | null;
  upper: number | null;
  confidence: string | null;
  evidence: unknown;
}

/** Flattens a model run into the append-only snapshot rows. */
export function snapshotsFrom(out: ModelOutput): Snapshot[] {
  const rows: Snapshot[] = [];
  const e = out.estimate;
  const push = (metric: string, value: number | null, lower: number | null = null, upper: number | null = null, confidence: string | null = null, evidence: unknown = null) =>
    rows.push({ asOf: out.asOf, metric, value, lower, upper, confidence, evidence });
  if (e.withheld) push("vdot", null, null, null, null, { withheld: true, reason: e.reason });
  else push("vdot", e.vdot, e.lower, e.upper, e.confidence, { method: e.method, notes: e.notes, evidence: e.evidence.map((x) => ({ id: x.activityId, kind: x.kind, value: x.value })) });
  for (const p of out.predictions ?? []) push(`race_${p.key}`, p.timeS, p.fastS, p.slowS, p.confidence, p.note ? { note: p.note } : null);
  if (out.threshold) push("threshold_pace", out.threshold.paceSPerKm, out.threshold.paceRange[0], out.threshold.paceRange[1], e.withheld ? null : e.confidence);
  if (out.threshold?.hr) push("threshold_hr", out.threshold.hr);
  if (out.physiology.maxHr) push("max_hr", out.physiology.maxHr.value, null, null, null, { source: out.physiology.maxHr.source });
  if (out.physiology.restHr) push("rest_hr", out.physiology.restHr.value, null, null, null, { source: out.physiology.restHr.source });
  const last = out.load[out.load.length - 1];
  if (last) {
    push("ctl", last.ctl);
    push("atl", last.atl);
    push("tsb", last.tsb);
  }
  if (out.efficiency.changePer30dPct != null) push("ef_trend_30d_pct", out.efficiency.changePer30dPct, null, null, null, { points: out.efficiency.points.length });
  return rows;
}

/** Sundays (end of each week) from the first run until `asOf`, newest last. */
export function retrospectiveDates(firstRunDate: string, asOf: string, maxWeeks = 104): string[] {
  const out: string[] = [];
  let d = addDaysIso(weekStart(firstRunDate), 6);
  while (d < asOf) {
    out.push(d);
    d = addDaysIso(d, 7);
  }
  return out.slice(-maxWeeks);
}
