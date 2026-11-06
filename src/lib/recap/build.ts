/**
 * Weekly recap (`recap@1`): how the week that just ended went, how the plan
 * changed, and which estimates moved. Pure, so it can be unit tested; the
 * service gathers the rows and stores the result in `weekly_recaps`.
 *
 * Two parts are kept apart on purpose:
 *  - `EstimateSnapshot` freezes what the model said when the week was
 *    reviewed. One is stored per week, so estimates can be compared over
 *    any span later, even after the plan or model changes.
 *  - `WeekRecap` is the review itself (planned vs done, trends, plan
 *    changes, estimate changes against the previous snapshot).
 */
import { addDaysIso, weekStart } from "../dates";
import { fmtDist, fmtTime, type Confidence } from "../analytics/fitness/estimate";
import { formatPace } from "../units";
import { WORKOUT_LABEL, type Phase, type PlanWeek, type WorkoutType } from "../planning/types";

export const RECAP_VERSION = "recap@2";

/* ------------------------------------------------------------------ */
/* Estimate snapshot                                                   */
/* ------------------------------------------------------------------ */

export interface PredictionSnap {
  key: string;
  label: string;
  distanceM: number;
  timeS: number;
  fastS: number | null;
  slowS: number | null;
}

export interface RaceSnap {
  name: string;
  distanceM: number;
  raceDate: string | null;
  targetTimeS: number | null;
  /** predicted time at current fitness */
  predictedS: number | null;
  fastS: number | null;
  slowS: number | null;
  /** "if you follow the plan" projection */
  projectedS: number | null;
  verdict: string | null;
}

export interface EstimateSnapshot {
  /** date the fitness model was computed for */
  asOf: string | null;
  modelVersion: string | null;
  vdot: { value: number; lower: number | null; upper: number | null; confidence: Confidence | null } | null;
  predictions: PredictionSnap[];
  thresholdPaceS: number | null;
  thresholdHr: number | null;
  /** chronic training load (fitness), acute load (fatigue) and their balance (form) */
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  rampRate: number | null;
  /** aerobic efficiency change per 30 days, % */
  efTrendPct: number | null;
  restHr: number | null;
  maxHr: number | null;
  longestRecentM: number | null;
  race: RaceSnap | null;
  /** what produced the numbers: the stored model output, or the weekly model history (first recap only) */
  source: "model" | "history";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Freezes the stored fitness model output (fitness_state.output) into a snapshot. */
export function snapshotFromModel(
  output: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  modelVersion: string | null,
  race: RaceSnap | null,
): EstimateSnapshot {
  const est = output?.estimate;
  const ok = est && est.withheld === false;
  const last = Array.isArray(output?.load) && output.load.length ? output.load[output.load.length - 1] : null;
  return {
    asOf: output?.asOf ?? null,
    modelVersion,
    vdot: ok ? { value: est.vdot, lower: num(est.lower), upper: num(est.upper), confidence: est.confidence ?? null } : null,
    predictions: ((output?.predictions ?? []) as PredictionSnap[]).map((p) => ({
      key: p.key,
      label: p.label,
      distanceM: p.distanceM,
      timeS: p.timeS,
      fastS: num(p.fastS),
      slowS: num(p.slowS),
    })),
    thresholdPaceS: num(output?.threshold?.paceSPerKm),
    thresholdHr: num(output?.threshold?.hr),
    ctl: num(last?.ctl),
    atl: num(last?.atl),
    tsb: num(last?.tsb),
    rampRate: num(output?.rampRate),
    efTrendPct: num(output?.efficiency?.changePer30dPct),
    restHr: num(output?.physiology?.restHr?.value),
    maxHr: num(output?.physiology?.maxHr?.value),
    longestRecentM: num(output?.longestRecentM),
    race,
    source: "model",
  };
}

const RACE_KEYS: Record<string, { label: string; distanceM: number }> = {
  "5k": { label: "5 km", distanceM: 5000 },
  "10k": { label: "10 km", distanceM: 10_000 },
  half: { label: "Half marathon", distanceM: 21_097.5 },
  marathon: { label: "Marathon", distanceM: 42_195 },
};

/**
 * Rebuilds a snapshot from the weekly model history (fitness_snapshots rows
 * for one date). Used only when there is no earlier recap to compare with.
 */
export function snapshotFromHistory(
  rows: { metric: string; value: number | null; lower_bound: number | null; upper_bound: number | null; confidence: string | null }[],
  asOf: string,
  modelVersion: string | null,
): EstimateSnapshot | null {
  const by = new Map(rows.map((r) => [r.metric, r]));
  const v = (m: string) => num(by.get(m)?.value);
  const vd = by.get("vdot");
  if (!rows.length) return null;
  return {
    asOf,
    modelVersion,
    vdot: vd && num(vd.value) != null ? { value: vd.value!, lower: num(vd.lower_bound), upper: num(vd.upper_bound), confidence: (vd.confidence as Confidence) ?? null } : null,
    predictions: Object.entries(RACE_KEYS)
      .map(([key, r]) => {
        const row = by.get(`race_${key}`);
        return row && num(row.value) != null ? { key, label: r.label, distanceM: r.distanceM, timeS: row.value!, fastS: num(row.lower_bound), slowS: num(row.upper_bound) } : null;
      })
      .filter((p): p is PredictionSnap => p != null),
    thresholdPaceS: v("threshold_pace"),
    thresholdHr: v("threshold_hr"),
    ctl: v("ctl"),
    atl: v("atl"),
    tsb: v("tsb"),
    rampRate: null,
    efTrendPct: v("ef_trend_30d_pct"),
    restHr: v("rest_hr"),
    maxHr: v("max_hr"),
    longestRecentM: null,
    race: null,
    source: "history",
  };
}

/* ------------------------------------------------------------------ */
/* Estimate changes                                                    */
/* ------------------------------------------------------------------ */

export type ChangeFormat = "vdot" | "time" | "pace" | "load" | "bpm";
export type Direction = "better" | "worse" | "same";

export interface EstimateChange {
  key: string;
  label: string;
  format: ChangeFormat;
  before: number;
  after: number;
  /** after − before */
  delta: number;
  direction: Direction;
  /** short explanation of what the number means */
  hint?: string;
}

/** Changes smaller than this are "unchanged" (noise, not news). */
const MIN_CHANGE: Record<ChangeFormat, (before: number) => number> = {
  vdot: () => 0.2,
  time: (b) => Math.max(2, b * 0.003),
  pace: () => 2,
  load: () => 0.5,
  bpm: () => 1,
};

function change(key: string, label: string, format: ChangeFormat, before: number | null | undefined, after: number | null | undefined, higherIsBetter: boolean, hint?: string): EstimateChange | null {
  if (before == null || after == null) return null;
  const delta = after - before;
  const direction: Direction = Math.abs(delta) < MIN_CHANGE[format](Math.abs(before)) ? "same" : delta > 0 === higherIsBetter ? "better" : "worse";
  return { key, label, format, before, after, delta, direction, ...(hint ? { hint } : {}) };
}

/** What moved between two snapshots, most important first. */
export function compareEstimates(prev: EstimateSnapshot | null, cur: EstimateSnapshot): EstimateChange[] {
  if (!prev) return [];
  const out: (EstimateChange | null)[] = [];
  out.push(change("vdot", "VO2max estimate (VDOT)", "vdot", prev.vdot?.value, cur.vdot?.value, true, "Your running fitness, from runs with reliable pace and heart rate"));
  const race = cur.race;
  const prevRace = prev.race && race && Math.abs(prev.race.distanceM - race.distanceM) < 1 ? prev.race : null;
  if (race) {
    // the goal race: compare with the earlier goal prediction, or the standard prediction for the same distance
    const prevPred = prevRace?.predictedS ?? prev.predictions.find((p) => Math.abs(p.distanceM - race.distanceM) < 1)?.timeS ?? null;
    out.push(change("race_goal", `${race.name}: predicted`, "time", prevPred, race.predictedS, false));
    out.push(change("race_projection", `${race.name}: if you follow the plan`, "time", prevRace?.projectedS, race.projectedS, false));
  }
  for (const p of cur.predictions) {
    if (race && Math.abs(p.distanceM - race.distanceM) < 1) continue;
    const b = prev.predictions.find((x) => x.key === p.key);
    out.push(change(`race_${p.key}`, `${p.label} prediction`, "time", b?.timeS, p.timeS, false));
  }
  out.push(change("threshold_pace", "Threshold pace", "pace", prev.thresholdPaceS, cur.thresholdPaceS, false, "Roughly the pace you could hold for an hour"));
  out.push(change("ctl", "Fitness (training load)", "load", prev.ctl, cur.ctl, true, "6-week average training load (CTL)"));
  out.push(change("rest_hr", "Resting heart rate", "bpm", prev.restHr, cur.restHr, false));
  return out.filter((c): c is EstimateChange => c != null);
}

export function formatChangeValue(format: ChangeFormat, v: number): string {
  switch (format) {
    case "vdot":
      return v.toFixed(1);
    case "time":
      return fmtTime(v);
    case "pace":
      return `${formatPace(v)}/km`;
    case "load":
      return v.toFixed(1);
    case "bpm":
      return `${Math.round(v)} bpm`;
  }
}

export function formatChangeDelta(c: Pick<EstimateChange, "format" | "delta">): string {
  const sign = c.delta > 0 ? "+" : c.delta < 0 ? "−" : "±";
  const a = Math.abs(c.delta);
  switch (c.format) {
    case "vdot":
    case "load":
      return `${sign}${a.toFixed(1)}`;
    case "time":
      return `${sign}${fmtTime(a)}`;
    case "pace":
      return `${sign}${Math.round(a)} s/km`;
    case "bpm":
      return `${sign}${Math.round(a)} bpm`;
  }
}

/* ------------------------------------------------------------------ */
/* The week                                                            */
/* ------------------------------------------------------------------ */

export interface RecapRun {
  date: string;
  movingS: number | null;
  distanceM: number | null;
}

export interface RecapWorkout {
  date: string;
  type: WorkoutType | string;
  title: string;
  status: string;
  key: boolean;
  durationS: number;
  /** moving time of the run it was matched to */
  actualS?: number | null;
}

export interface RecapSession {
  date: string;
  type: string;
  title: string;
  status: "completed" | "missed" | "skipped" | "planned";
  key: boolean;
  plannedMin: number;
  actualMin: number | null;
}

export interface WeekRecap {
  version: typeof RECAP_VERSION;
  weekStart: string;
  weekEnd: string;
  volume: { runs: number; minutes: number; km: number; longestKm: number };
  /** average of the 4 weeks before (null without history) */
  typical: { runs: number; minutes: number; km: number } | null;
  /** weekly km, last 8 weeks ending with this one, oldest first */
  weeklyKm: { weekStart: string; km: number }[];
  /** where this week's km ranks among the last 8 weeks (1 = most), and the last week with more */
  rank: { position: number; of: number; lastBiggerWeek: string | null } | null;
  plan: {
    weekIndex: number;
    totalWeeks: number;
    phase: Phase;
    targetMinutes: number;
    sessions: RecapSession[];
    done: number;
    total: number;
    missed: number;
    skipped: number;
    keyDone: number;
    keyTotal: number;
  } | null;
  /** predicted goal-race time at the end of each recent week, oldest first */
  raceTrend: { weekStart: string; timeS: number }[];
  /** previous snapshot the changes are measured from */
  comparedWith: { weekStart: string | null; asOf: string | null; source: "recap" | "history" } | null;
  changes: EstimateChange[];
  /** load warning when the week was a big jump */
  caution: string | null;
  headline: string;
  points: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function buildWeekRecap(input: {
  weekStart: string;
  /** runs from at least 7 weeks before the week through its end */
  runs: RecapRun[];
  planWeeks: PlanWeek[] | null;
  /** workouts of the reviewed week (rest days included or not) */
  workouts: RecapWorkout[];
  raceTrend?: { weekStart: string; timeS: number }[];
  current: EstimateSnapshot;
  previous: EstimateSnapshot | null;
  comparedWith: WeekRecap["comparedWith"];
}): WeekRecap {
  const ws = weekStart(input.weekStart);
  const we = addDaysIso(ws, 6);
  const weeks = Array.from({ length: 8 }, (_, i) => addDaysIso(ws, -7 * (7 - i)));
  const agg = new Map(weeks.map((w) => [w, { runs: 0, s: 0, m: 0, longest: 0 }]));
  for (const r of input.runs) {
    const a = agg.get(weekStart(r.date));
    if (!a) continue;
    a.runs += 1;
    a.s += r.movingS ?? 0;
    a.m += r.distanceM ?? 0;
    a.longest = Math.max(a.longest, r.distanceM ?? 0);
  }
  const cur = agg.get(ws)!;
  const volume = { runs: cur.runs, minutes: Math.round(cur.s / 60), km: r1(cur.m / 1000), longestKm: r1(cur.longest / 1000) };
  const before = weeks.slice(3, 7).map((w) => agg.get(w)!);
  const hadHistory = weeks.slice(0, 7).some((w) => agg.get(w)!.runs > 0);
  const typical = hadHistory
    ? {
        runs: r1(before.reduce((s, a) => s + a.runs, 0) / before.length),
        minutes: Math.round(before.reduce((s, a) => s + a.s, 0) / before.length / 60),
        km: r1(before.reduce((s, a) => s + a.m, 0) / before.length / 1000),
      }
    : null;
  const weeklyKm = weeks.map((w) => ({ weekStart: w, km: r1(agg.get(w)!.m / 1000) }));
  const rank =
    hadHistory && volume.runs
      ? {
          position: 1 + weeklyKm.slice(0, 7).filter((w) => w.km > volume.km).length,
          of: weeklyKm.length,
          lastBiggerWeek: weeklyKm.slice(0, 7).filter((w) => w.km > volume.km).at(-1)?.weekStart ?? null,
        }
      : null;

  // plan: planned vs done
  const pw = input.planWeeks?.find((w) => w.start === ws) ?? null;
  const sessions: RecapSession[] = input.workouts
    .filter((w) => w.type !== "rest" && w.date >= ws && w.date <= we)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((w) => ({
      date: w.date,
      type: w.type,
      title: w.title || WORKOUT_LABEL[w.type as WorkoutType] || "Run",
      status: (["completed", "missed", "skipped"].includes(w.status) ? w.status : "planned") as RecapSession["status"],
      key: w.key,
      plannedMin: Math.round(w.durationS / 60),
      actualMin: w.actualS != null ? Math.round(w.actualS / 60) : null,
    }));
  const plan =
    pw || sessions.length
      ? {
          weekIndex: pw?.index ?? 0,
          totalWeeks: input.planWeeks?.length ?? 0,
          phase: pw?.phase ?? ("base" as Phase),
          targetMinutes: pw?.targetMinutes ?? sessions.reduce((s, x) => s + x.plannedMin, 0),
          sessions,
          done: sessions.filter((s) => s.status === "completed").length,
          total: sessions.length,
          missed: sessions.filter((s) => s.status === "missed" || s.status === "planned").length,
          skipped: sessions.filter((s) => s.status === "skipped").length,
          keyDone: sessions.filter((s) => s.key && s.status === "completed").length,
          keyTotal: sessions.filter((s) => s.key).length,
        }
      : null;

  const changes = compareEstimates(input.previous, input.current);

  // injury safety: a week far above your usual load is worth flagging, whatever the plan said
  let caution: string | null = null;
  if (typical && typical.minutes >= 30 && volume.minutes > typical.minutes * 1.3) {
    caution = `${Math.round((volume.minutes / typical.minutes - 1) * 100)} % above your 4-week average. Keep the next few runs easy.`;
  } else if (input.current.rampRate != null && input.current.rampRate > 8) {
    caution = "Training load is rising fast. An easier few days lowers the injury risk.";
  }

  const { headline, points } = narrate({ volume, plan });
  return {
    version: RECAP_VERSION,
    weekStart: ws,
    weekEnd: we,
    volume,
    typical,
    weeklyKm,
    rank,
    plan,
    raceTrend: (input.raceTrend ?? []).filter((p) => p.weekStart <= ws).sort((a, b) => a.weekStart.localeCompare(b.weekStart)).slice(-8),
    comparedWith: input.previous ? input.comparedWith : null,
    changes,
    caution,
    headline,
    points,
  };
}

function narrate(r: Pick<WeekRecap, "volume" | "plan">): { headline: string; points: string[] } {
  const { volume, plan } = r;
  const points: string[] = [];
  let headline: string;
  if (plan && plan.total > 0) {
    const ratio = plan.done / plan.total;
    if (plan.done === plan.total) headline = plan.total === 1 ? "The planned run is done" : `All ${plan.total} planned runs done`;
    else if (ratio >= 0.6) headline = `${plan.done} of ${plan.total} planned runs done`;
    else if (plan.done > 0) headline = `A lighter week: ${plan.done} of ${plan.total} runs`;
    else headline = volume.runs ? "Off-plan week" : "A week off";
    if (plan.keyTotal) points.push(`${plan.keyDone} of ${plan.keyTotal} key session${plan.keyTotal === 1 ? "" : "s"} done`);
  } else if (volume.runs === 0) {
    headline = "A week off";
  } else {
    headline = `${volume.runs} run${volume.runs === 1 ? "" : "s"}, ${volume.km} km`;
  }
  return { headline, points };
}

/** Changes shown as key metrics (the rest are "other estimates"). */
export const KEY_METRICS = ["race_goal", "race_projection", "vdot", "ctl", "threshold_pace"];

export { fmtDist };
