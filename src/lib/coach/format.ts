/**
 * Pure formatting of training data into compact, labelled text for the coach.
 * Every line says where a number comes from (measured by the watch,
 * calculated from measurements, or estimated by the fitness model), so the
 * coach can pass that distinction on. No I/O here; see `data.ts`.
 */
import { addDaysIso, daysBetween, formatDay, weekStart } from "../dates";
import { formatDuration, formatPace } from "../units";
import { fmtTime } from "../analytics/fitness/estimate";
import { GOAL_LABEL, PHASE_LABEL, WORKOUT_LABEL, type GoalKind, type Phase, type Step, type WorkoutType } from "../planning/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RunRow {
  id: string;
  date: string;
  name: string | null;
  distanceM: number | null;
  movingS: number | null;
  avgHr: number | null;
  maxHr: number | null;
  elevationGainM: number | null;
  isIndoor: boolean;
  usableForFitness: boolean;
  qualityIssues: string[];
  classification: string | null;
  ef: number | null;
  decouplingPct: number | null;
  trimp: number | null;
  rpe: number | null;
  legs: string | null;
  notes: string | null;
}

export interface WeekRow {
  start: string;
  km: number;
  minutes: number;
  runs: number;
  longestKm: number;
}

export interface WorkoutRow {
  id: string;
  date: string;
  type: WorkoutType;
  title: string;
  durationS: number;
  distanceM: number | null;
  key: boolean;
  locked: boolean;
  status: string;
  steps: Step[];
  execution: any | null;
  activityId: string | null;
}

export interface MetricPoint {
  asOf: string;
  kind: "contemporaneous" | "retrospective";
  value: number | null;
  lower: number | null;
  upper: number | null;
  confidence: string | null;
}

const km = (m: number | null | undefined, d = 1) => (m == null ? "–" : `${(m / 1000).toFixed(d)} km`);
const pace = (distanceM: number | null, movingS: number | null) => (distanceM && movingS && distanceM > 200 ? `${formatPace(movingS / (distanceM / 1000))}/km` : "–");

export function runLine(r: RunRow): string {
  const bits = [
    `${r.date} (${formatDay(r.date)})`,
    r.name ? `"${r.name}"` : null,
    km(r.distanceM, 2),
    formatDuration(r.movingS),
    pace(r.distanceM, r.movingS),
    r.avgHr ? `avg HR ${Math.round(r.avgHr)}` : "no HR",
    r.elevationGainM != null ? `+${Math.round(r.elevationGainM)} m` : null,
    r.classification ? `type: ${r.classification}` : null,
    r.ef != null ? `EF ${r.ef.toFixed(2)}` : null,
    r.decouplingPct != null ? `decoupling ${r.decouplingPct.toFixed(1)} %` : null,
    r.trimp != null ? `TRIMP ${Math.round(r.trimp)}` : null,
    r.rpe != null ? `RPE ${r.rpe}/10` : null,
    r.legs ? `legs ${r.legs}` : null,
    r.isIndoor ? "treadmill/indoor" : null,
    !r.usableForFitness ? "EXCLUDED from fitness model (data quality)" : null,
    r.qualityIssues.length ? `quality: ${r.qualityIssues.join(", ")}` : null,
    r.notes ? `note: "${r.notes.slice(0, 140)}"` : null,
    `id ${r.id}`,
  ];
  return bits.filter(Boolean).join(" · ");
}

/** Monday-based weekly totals for the `weeks` weeks ending with the week containing `today`. */
export function weeklyTotals(runs: { date: string; distanceM: number | null; movingS: number | null }[], today: string, weeks: number): WeekRow[] {
  const first = addDaysIso(weekStart(today), -7 * (weeks - 1));
  const rows: WeekRow[] = [];
  for (let i = 0; i < weeks; i++) rows.push({ start: addDaysIso(first, 7 * i), km: 0, minutes: 0, runs: 0, longestKm: 0 });
  for (const r of runs) {
    if (r.date < first || r.date > addDaysIso(weekStart(today), 6)) continue;
    const idx = Math.floor(daysBetween(first, r.date) / 7);
    const w = rows[idx];
    const k = (r.distanceM ?? 0) / 1000;
    w.km += k;
    w.minutes += (r.movingS ?? 0) / 60;
    w.runs += 1;
    w.longestKm = Math.max(w.longestKm, k);
  }
  return rows.map((w) => ({ ...w, km: Math.round(w.km * 10) / 10, minutes: Math.round(w.minutes), longestKm: Math.round(w.longestKm * 10) / 10 }));
}

export function weekLine(w: WeekRow, today: string): string {
  const current = w.start === weekStart(today) ? " (this week, in progress)" : "";
  return `week of ${w.start}${current}: ${w.km} km, ${w.minutes} min, ${w.runs} run${w.runs === 1 ? "" : "s"}, longest ${w.longestKm} km`;
}

function stepsSummary(steps: Step[]): string {
  const parts: string[] = [];
  for (const s of steps) {
    if (s.kind === "repeat") parts.push(`${s.count}× [${stepsSummary(s.steps)}]`);
    else {
      const len = s.distanceM ? `${Math.round(s.distanceM)} m` : s.durationS ? `${Math.round(s.durationS / 60)} min` : "";
      parts.push(`${s.kind} ${len} ${s.target.label}`.replace(/\s+/g, " ").trim());
    }
  }
  return parts.join(", ");
}

export function workoutLine(w: WorkoutRow, withSteps = false): string {
  const ex = w.execution;
  const bits = [
    `${w.date} (${formatDay(w.date)})`,
    w.title,
    `[${w.type}]`,
    w.type !== "rest" ? `${Math.round(w.durationS / 60)} min` : null,
    w.distanceM ? `~${km(w.distanceM)}` : null,
    w.key ? "KEY session" : null,
    w.locked ? "locked by athlete" : null,
    `status: ${w.status}`,
    ex ? `execution: ${ex.verdict}${ex.paceDeltaPct != null ? `, pace ${ex.paceDeltaPct >= 0 ? "+" : ""}${ex.paceDeltaPct.toFixed(1)} % vs target (positive = faster)` : ""}${ex.durationRatio != null ? `, duration ${Math.round(ex.durationRatio * 100)} % of plan` : ""}` : null,
    withSteps && w.steps.length ? `steps: ${stepsSummary(w.steps)}` : null,
    `workout id ${w.id}`,
  ];
  return bits.filter(Boolean).join(" · ");
}

const METRIC_FMT: Record<string, (v: number) => string> = {
  vdot: (v) => v.toFixed(1),
  threshold_pace: (v) => `${formatPace(v)}/km`,
  race_5k: fmtTime,
  race_10k: fmtTime,
  race_half: fmtTime,
  race_marathon: fmtTime,
};

export const formatMetric = (metric: string, v: number | null) => (v == null ? "withheld" : (METRIC_FMT[metric]?.(v) ?? (Math.round(v * 10) / 10).toString()));

export function metricLine(metric: string, p: MetricPoint): string {
  const range = p.lower != null && p.upper != null ? ` (range ${formatMetric(metric, p.lower)}–${formatMetric(metric, p.upper)})` : "";
  return `${p.asOf} ${p.kind === "retrospective" ? "retro" : "live"}: ${formatMetric(metric, p.value)}${range}${p.confidence ? `, ${p.confidence} confidence` : ""}`;
}

/** The value closest to (and not after) `date`, preferring retrospective rows (same model, same rules). */
export function valueAt(points: MetricPoint[], date: string): MetricPoint | null {
  const before = points.filter((p) => p.asOf <= date).sort((a, b) => a.asOf.localeCompare(b.asOf) || (a.kind === "retrospective" ? 1 : -1));
  return before.at(-1) ?? null;
}

export interface SnapshotInput {
  today: string;
  timezone: string;
  profile: { maxHr: any; restHr: any } | null;
  fitness: any | null; // ModelOutput subset
  fitnessComputedAt: string | null;
  history: Record<string, MetricPoint[]>;
  weeks: WeekRow[];
  recentRuns: RunRow[];
  totalRuns: number;
  firstRunDate: string | null;
  plan: {
    goal: { kind: GoalKind; name: string | null; distanceM: number | null; raceDate: string | null; targetTimeS: number | null; targetWeeklyKm: number | null };
    weeks: { index: number; start: string; phase: Phase; targetMinutes: number; note: string }[];
    vdot: number | null;
    racePace: number | null;
    createdAt: string;
    warnings: string[];
    config: any;
  } | null;
  workouts: WorkoutRow[];
  proposals: { id?: string; title: string; status: string; created_at: string; rule: string }[];
  routes?: RouteRow[];
  wellness: { date: string; metric: string; value: number | null }[];
}

/** The athlete snapshot given to the coach at the start of every turn. */
export function renderSnapshot(s: SnapshotInput): string {
  const L: string[] = [];
  L.push(`Today is ${s.today} (${formatDay(s.today, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}), athlete's time zone ${s.timezone}.`);
  L.push(`Imported runs: ${s.totalRuns}${s.firstRunDate ? `, first on ${s.firstRunDate}` : ""}. Watch: Garmin vívoactive 5.`);

  // fitness
  L.push("", "## Fitness model (estimated; deterministic, documented in docs/ANALYTICS.md)");
  const f = s.fitness;
  if (!f) L.push("No fitness model output yet (not enough imported runs, or not computed).");
  else {
    if (s.fitnessComputedAt) L.push(`Computed ${s.fitnessComputedAt.slice(0, 16).replace("T", " ")} UTC, as of ${f.asOf}.`);
    const e = f.estimate;
    if (e?.withheld) L.push(`VDOT (VO2max-equivalent performance estimate): WITHHELD — ${e.reason}`);
    else if (e) {
      L.push(`VDOT ${e.vdot.toFixed(1)} (range ${e.lower.toFixed(1)}–${e.upper.toFixed(1)}, ${e.confidence} confidence, method: ${e.method === "performance" ? "best recent efforts" : e.method === "hr_calibrated" ? `heart rate vs pace in every run (level ${e.hrLevel ?? "?"}), calibrated with hard efforts (offset ${e.offset ?? 0})` : "heart rate vs pace in every run"}). Tracked from all runs like a watch estimate, not a lab VO2max and not Garmin's own number.`);
      for (const n of e.notes ?? []) L.push(`  note: ${n}`);
      const ev = (e.evidence ?? []).slice(0, 5);
      if (ev.length) L.push(`  evidence: ${ev.map((x: any) => `${x.date} ${x.detail ?? x.kind} → ${Number(x.value).toFixed(1)} (run ${x.activityId})`).join("; ")}`);
    }
    if (f.threshold) L.push(`Threshold pace ${formatPace(f.threshold.paceSPerKm)}/km (range ${formatPace(f.threshold.paceRange[0])}–${formatPace(f.threshold.paceRange[1])})${f.threshold.hr ? `, threshold HR ≈ ${f.threshold.hr} bpm (${f.threshold.hrNote})` : ""}.`);
    if (f.paceZones?.length) L.push(`Training paces (calculated from VDOT): ${f.paceZones.map((z: any) => `${z.label} ${formatPace(z.fastSPerKm)}–${formatPace(z.slowSPerKm)}/km`).join("; ")}.`);
    if (f.hrZones?.length) L.push(`HR zones (Karvonen): ${f.hrZones.map((z: any) => `Z${z.zone} ${z.label} ${z.minBpm}–${z.maxBpm}`).join("; ")}.`);
    if (f.predictions?.length)
      L.push(`Race predictions (estimated): ${f.predictions.map((p: any) => `${p.label} ${fmtTime(p.timeS)} (${fmtTime(p.fastS)}–${fmtTime(p.slowS)}, ${p.confidence}${p.note ? `; ${p.note}` : ""})`).join("; ")}.`);
    const ph = f.physiology;
    if (ph) L.push(`Max HR ${ph.maxHr ? `${ph.maxHr.value} (${ph.maxHr.source}: ${ph.maxHr.note})` : "unknown"}; resting HR ${ph.restHr ? `${ph.restHr.value} (${ph.restHr.source}: ${ph.restHr.note})` : "unknown"}.`);
    const ld = f.load?.at?.(-1);
    if (ld) L.push(`Training load (calculated, Banister TRIMP): fitness/CTL ${ld.ctl.toFixed(0)}, fatigue/ATL ${ld.atl.toFixed(0)}, form/TSB ${ld.tsb.toFixed(0)} on ${ld.date}${f.rampRate != null ? `; CTL ramp ${f.rampRate.toFixed(1)}/week` : ""}.`);
    if (f.efficiency) L.push(`Aerobic efficiency (EF on easy/long/steady runs, last 120 days): ${f.efficiency.changePer30dPct != null ? `${f.efficiency.changePer30dPct >= 0 ? "+" : ""}${f.efficiency.changePer30dPct.toFixed(1)} % per 30 days over ${f.efficiency.points.length} runs` : `trend not supported yet (${f.efficiency.points?.length ?? 0} comparable runs over ${f.efficiency.spanDays} days)`}.`);
    if (f.longestRecentM) L.push(`Longest run in the last 8 weeks: ${km(f.longestRecentM)}.`);
    const be = f.bestEfforts?.last90 ?? [];
    if (be.length) L.push(`Best efforts, last 90 days (measured segments): ${be.slice(0, 6).map((b: any) => `${km(b.distanceM, b.distanceM % 1000 ? 2 : 0)} ${fmtTime(b.timeS)} on ${b.date}`).join("; ")}.`);
  }

  // trends
  const trendKeys = ["vdot", "race_10k", "threshold_pace", "ctl"].filter((k) => s.history[k]?.length);
  if (trendKeys.length) {
    L.push("", "## How the estimates moved (weekly retrospective snapshots; use get_metric_history for more)");
    for (const k of trendKeys) {
      const pts = s.history[k];
      const at = (days: number) => valueAt(pts, addDaysIso(s.today, -days));
      const cells = [
        ["now", valueAt(pts, s.today)],
        ["4 wk ago", at(28)],
        ["3 mo ago", at(91)],
        ["6 mo ago", at(182)],
        ["12 mo ago", at(365)],
      ] as const;
      L.push(`${k}: ${cells.map(([label, p]) => `${label} ${p ? formatMetric(k, p.value) : "–"}`).join(" · ")}`);
    }
  }

  // volume
  L.push("", "## Weekly running volume (measured), oldest first");
  for (const w of s.weeks) L.push(weekLine(w, s.today));

  L.push("", `## Most recent runs (newest first; use get_runs / get_run_detail for more)`);
  if (!s.recentRuns.length) L.push("No runs imported.");
  for (const r of s.recentRuns) L.push(runLine(r));

  // plan
  L.push("", "## Training plan");
  if (!s.plan) L.push("No active plan. The athlete can create one on the Plan tab.");
  else {
    const g = s.plan.goal;
    const target = g.targetTimeS ? `, target ${fmtTime(g.targetTimeS)}` : "";
    const race = g.raceDate ? `, race on ${g.raceDate} (${daysBetween(s.today, g.raceDate)} days away)` : "";
    L.push(`Goal: ${GOAL_LABEL[g.kind] ?? g.kind}${g.name ? ` "${g.name}"` : ""}${g.distanceM ? `, ${km(g.distanceM)}` : ""}${target}${race}${g.targetWeeklyKm ? `, target ${g.targetWeeklyKm} km/week` : ""}.`);
    if (g.targetTimeS && g.distanceM) L.push(`Target pace ${formatPace(g.targetTimeS / (g.distanceM / 1000))}/km.`);
    L.push(`Plan paces were set from VDOT ${s.plan.vdot?.toFixed(1) ?? "unknown"}${s.plan.racePace ? `, race pace ${formatPace(s.plan.racePace)}/km` : ""}. Created ${s.plan.createdAt.slice(0, 10)}.`);
    const cfg = s.plan.config ?? {};
    const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    if (cfg.runDays) L.push(`Run days: ${cfg.runDays.map((d: number) => DAYS[d]).join(", ")}${cfg.includeLongRuns ? (cfg.longRunDay != null ? `; long run ${DAYS[cfg.longRunDay]}` : "; long run day: best fit (planner picks)") : ""}${cfg.unavailableDays?.length ? `; unavailable ${cfg.unavailableDays.map((d: number) => DAYS[d]).join(", ")}` : ""}${cfg.maxWeeklyMinutes ? `; max ${cfg.maxWeeklyMinutes} min/week` : ""}; intervals ${cfg.includeIntervals ? "yes" : "no"}, long runs ${cfg.includeLongRuns ? "yes" : "no"}.`);
    const cur = [...s.plan.weeks].reverse().find((w) => w.start <= s.today);
    if (cur) L.push(`Current week ${cur.index + 1} of ${s.plan.weeks.length}: ${PHASE_LABEL[cur.phase] ?? cur.phase}, ~${cur.targetMinutes} min. ${cur.note}`);
    L.push(`Phases: ${phaseRuns(s.plan.weeks)}.`);
    for (const w of s.plan.warnings) L.push(`Plan warning: ${w}`);
    const past = s.workouts.filter((w) => w.date < s.today && w.date >= addDaysIso(s.today, -14));
    const next = s.workouts.filter((w) => w.date >= s.today && w.date <= addDaysIso(s.today, 14));
    L.push("", "Last 14 days of the plan:");
    if (!past.length) L.push("(none)");
    for (const w of past) L.push(workoutLine(w));
    L.push("", "Next 14 days of the plan (workout ids work with the plan tools; get_plan_workouts reaches further):");
    if (!next.length) L.push("(none)");
    for (const w of next) L.push(workoutLine(w, true));
    if (s.proposals.length) {
      L.push("", "Recent plan-change proposals:");
      for (const p of s.proposals) L.push(`${p.created_at.slice(0, 10)} [${p.rule === "coach" ? "from coach" : `rule ${p.rule}`}] ${p.title}: ${p.status}${p.status === "pending" ? ` (proposal id ${p.id}; the athlete can accept or keep their plan, or ask you to)` : p.status === "rejected" && p.id ? ` (proposal id ${p.id}; declined, but can still be applied with respond_to_proposal if the athlete asks)` : ""}`);
    }
  }

  // routes
  L.push("", "## Saved routes (use get_routes for details)");
  if (!s.routes?.length) L.push("No saved routes.");
  else for (const r of s.routes) L.push(routeLine(r));

  // wellness
  L.push("", "## Wellness (measured by Garmin, last 7 days; supplementary only)");
  const wl = s.wellness.filter((w) => w.value != null);
  if (!wl.length) L.push("No wellness data synced.");
  else {
    const byDate = new Map<string, string[]>();
    for (const w of wl) byDate.set(w.date, [...(byDate.get(w.date) ?? []), `${w.metric} ${w.metric === "sleep_seconds" ? formatDuration(w.value) : Math.round(w.value! * 10) / 10}`]);
    for (const [d, v] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) L.push(`${d}: ${v.join(", ")}`);
  }
  return L.join("\n");
}

function phaseRuns(weeks: { phase: Phase; start: string }[]): string {
  const out: string[] = [];
  for (const w of weeks) {
    const last = out.at(-1);
    const label = PHASE_LABEL[w.phase] ?? w.phase;
    if (last?.startsWith(label + " ")) continue;
    out.push(`${label} from ${w.start}`);
  }
  return out.join(" → ");
}

export interface RouteRow {
  id: string;
  name: string;
  distanceM: number;
  elevationGainM: number | null;
  favorite: boolean;
  source: string;
  linkedWorkouts?: string[];
}

export function routeLine(r: RouteRow): string {
  return [
    r.name,
    km(r.distanceM),
    r.elevationGainM != null ? `+${Math.round(r.elevationGainM)} m (estimated)` : null,
    r.favorite ? "favourite" : null,
    r.source === "activity" ? "from a recorded run" : r.source === "loop" ? "generated loop" : "drawn",
    r.linkedWorkouts?.length ? `linked to workouts ${r.linkedWorkouts.join(", ")}` : null,
    `route id ${r.id}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export { WORKOUT_LABEL };
