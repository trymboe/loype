/**
 * Personal milestones, calculated from imported runs and the weekly fitness
 * history. Pure: everything is passed in. Each milestone records when it was
 * reached so the UI can mark recent ones as new.
 */
import { addDaysIso, daysBetween, formatDay, weekStart } from "../dates";
import { fmtDist, fmtTime } from "../analytics/fitness/estimate";

export interface MilestoneRun {
  id: string;
  date: string;
  distanceM: number | null;
  movingS: number | null;
  /** fastest stretches within the run (only from runs with reliable GPS) */
  bestEfforts: { distanceM: number; timeS: number }[];
}

export interface VdotPoint {
  date: string;
  value: number | null;
}

export type MilestoneKind = "distance" | "effort" | "volume" | "consistency" | "fitness" | "total";

export interface Milestone {
  key: string;
  kind: MilestoneKind;
  title: string;
  value: string;
  detail: string;
  date: string;
  activityId: string | null;
  /** reached in the last NEW_DAYS days */
  isNew: boolean;
}

export const NEW_DAYS = 14;
const EFFORT_DISTANCES = [
  { m: 1000, label: "1 km" },
  { m: 5000, label: "5 km" },
  { m: 10_000, label: "10 km" },
  { m: 21_097.5, label: "Half marathon" },
];
const DISTANCE_FIRSTS = [
  { m: 42_195, label: "First marathon distance" },
  { m: 30_000, label: "First 30 km run" },
  { m: 21_097.5, label: "First half-marathon distance" },
  { m: 15_000, label: "First 15 km run" },
  { m: 10_000, label: "First 10 km run" },
];
const TOTALS_KM = [5000, 2500, 1000, 500, 250, 100];
/** a dip has to be at least this many VDOT points before "back to previous fitness" counts */
const DIP_MIN = 1.5;
const RECOVERED_WITHIN = 0.3;
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export function computeMilestones(runs: MilestoneRun[], vdot: VdotPoint[], today: string): Milestone[] {
  const sorted = [...runs].filter((r) => r.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const out: Milestone[] = [];
  const push = (m: Omit<Milestone, "isNew">) => out.push({ ...m, isNew: daysBetween(m.date, today) <= NEW_DAYS });
  if (!sorted.length) return out;

  // longest run
  const longest = sorted.reduce((a, r) => ((r.distanceM ?? 0) > (a.distanceM ?? 0) ? r : a));
  if ((longest.distanceM ?? 0) > 0)
    push({
      key: "longest_run",
      kind: "distance",
      title: "Longest run",
      value: fmtDist(longest.distanceM!),
      detail: longest.movingS ? `in ${fmtTime(longest.movingS)}` : "",
      date: longest.date,
      activityId: longest.id,
    });

  // highest distance "first"
  for (const f of DISTANCE_FIRSTS) {
    const first = sorted.find((r) => (r.distanceM ?? 0) >= f.m * 0.995);
    if (first) {
      push({ key: `first_${f.m}`, kind: "distance", title: f.label, value: fmtDist(first.distanceM!), detail: "", date: first.date, activityId: first.id });
      break;
    }
  }

  // best efforts, and how much the latest record beat the one before it
  for (const d of EFFORT_DISTANCES) {
    let best: { timeS: number; run: MilestoneRun } | null = null;
    let previous: number | null = null;
    for (const r of sorted) {
      const e = r.bestEfforts.find((x) => Math.abs(x.distanceM - d.m) < 1);
      if (!e) continue;
      if (!best || e.timeS < best.timeS) {
        previous = best?.timeS ?? null;
        best = { timeS: e.timeS, run: r };
      }
    }
    if (best)
      push({
        key: `best_${d.m}`,
        kind: "effort",
        title: `Best ${d.label}`,
        value: fmtTime(best.timeS),
        detail: previous ? `${fmtTime(previous - best.timeS)} faster than your previous best` : "fastest stretch within a run",
        date: best.run.date,
        activityId: best.run.id,
      });
  }

  // biggest week
  const weeks = new Map<string, { km: number; last: string; runs: number }>();
  for (const r of sorted) {
    const w = weekStart(r.date);
    const cur = weeks.get(w) ?? { km: 0, last: r.date, runs: 0 };
    cur.km += (r.distanceM ?? 0) / 1000;
    cur.last = r.date;
    cur.runs++;
    weeks.set(w, cur);
  }
  const [bigW, big] = [...weeks.entries()].reduce((a, b) => (b[1].km > a[1].km ? b : a));
  push({
    key: "biggest_week",
    kind: "volume",
    title: "Biggest week",
    value: `${big.km.toFixed(1)} km`,
    detail: `${big.runs} run${big.runs === 1 ? "" : "s"}, week of ${formatDay(bigW, { day: "numeric", month: "short" })}`,
    date: big.last,
    activityId: null,
  });

  // most consistent month: most run days, then most distance
  const months = new Map<string, { days: Set<string>; km: number; last: string }>();
  for (const r of sorted) {
    const k = r.date.slice(0, 7);
    const cur = months.get(k) ?? { days: new Set(), km: 0, last: r.date };
    cur.days.add(r.date);
    cur.km += (r.distanceM ?? 0) / 1000;
    cur.last = r.date;
    months.set(k, cur);
  }
  const [mk, m] = [...months.entries()].reduce((a, b) => (b[1].days.size > a[1].days.size || (b[1].days.size === a[1].days.size && b[1].km > a[1].km) ? b : a));
  push({
    key: "consistent_month",
    kind: "consistency",
    title: "Most consistent month",
    value: `${m.days.size} run days`,
    detail: `${MONTH.format(new Date(`${mk}-01T00:00:00Z`))}, ${m.km.toFixed(0)} km`,
    date: m.last,
    activityId: null,
  });

  // longest streak of weeks with at least one run
  const runWeeks = [...weeks.keys()].sort();
  let streak = 1;
  let bestStreak = { len: 1, end: runWeeks[0] };
  for (let i = 1; i < runWeeks.length; i++) {
    streak = addDaysIso(runWeeks[i - 1], 7) === runWeeks[i] ? streak + 1 : 1;
    if (streak >= bestStreak.len) bestStreak = { len: streak, end: runWeeks[i] };
  }
  if (bestStreak.len >= 3)
    push({
      key: "week_streak",
      kind: "consistency",
      title: "Longest weekly streak",
      value: `${bestStreak.len} weeks`,
      detail: "in a row with at least one run",
      date: weeks.get(bestStreak.end)!.last,
      activityId: null,
    });

  // total distance
  let total = 0;
  const reached = new Map<number, MilestoneRun>();
  for (const r of sorted) {
    total += (r.distanceM ?? 0) / 1000;
    for (const t of TOTALS_KM) if (total >= t && !reached.has(t)) reached.set(t, r);
  }
  const topTotal = TOTALS_KM.find((t) => reached.has(t));
  if (topTotal) {
    const r = reached.get(topTotal)!;
    push({ key: `total_${topTotal}`, kind: "total", title: `${topTotal.toLocaleString("en-GB")} km run`, value: `${Math.round(total)} km`, detail: "since your first imported run", date: r.date, activityId: r.id });
  }

  // fitness: peak, and back to a previous level after a real dip
  const pts = vdot.filter((p): p is { date: string; value: number } => p.value != null && p.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length) {
    const peak = pts.reduce((a, p) => (p.value > a.value ? p : a));
    push({ key: "peak_vdot", kind: "fitness", title: "Highest fitness estimate", value: `VDOT ${peak.value.toFixed(1)}`, detail: "weekly estimate", date: peak.date, activityId: null });
    const back = backToPrevious(pts);
    if (back)
      push({
        key: "back_to_fitness",
        kind: "fitness",
        title: "Back to previous fitness",
        value: `VDOT ${back.value.toFixed(1)}`,
        detail: `after dropping to ${back.low.toFixed(1)} from ${back.before.toFixed(1)}`,
        date: back.date,
        activityId: null,
      });
  }

  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** The most recent time the estimate climbed back to a level it had dropped at least DIP_MIN below. */
export function backToPrevious(pts: { date: string; value: number }[]): { date: string; value: number; low: number; before: number } | null {
  let result: { date: string; value: number; low: number; before: number } | null = null;
  let peak = pts[0]?.value ?? 0;
  let low = Infinity;
  for (const p of pts) {
    if (peak - p.value >= DIP_MIN) low = Math.min(low, p.value);
    if (low !== Infinity && p.value >= peak - RECOVERED_WITHIN) {
      result = { date: p.date, value: p.value, low, before: peak };
      low = Infinity;
    }
    if (low === Infinity) peak = Math.max(peak, p.value);
  }
  return result;
}
