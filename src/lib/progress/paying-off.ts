/**
 * "Your training is paying off": compares the last block (8 weeks) with the
 * one before it. Every item comes from a calculation the athlete can check,
 * and declines are reported as plainly as gains. When there is too little
 * recent running to judge, it says so instead of guessing.
 */
import { addDaysIso, weekStart } from "../dates";
import { fmtDist, fmtTime } from "../analytics/fitness/estimate";
import { predictTimeS } from "../analytics/fitness/vdot";
import type { MilestoneRun, VdotPoint } from "./milestones";

export const BLOCK_WEEKS = 8;

export type Tone = "good" | "steady" | "down";

export interface PayoffItem {
  key: "vdot" | "efficiency" | "volume" | "consistency" | "long_run" | "best_effort";
  tone: Tone;
  title: string;
  detail: string;
  /** what was compared, shown under "how this is calculated" */
  basis: string;
}

export interface Payoff {
  state: "paying_off" | "steady" | "dipped" | "not_enough_data";
  headline: string;
  summary: string;
  items: PayoffItem[];
  from: string;
  to: string;
}

export interface EfPoint {
  date: string;
  ef: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);

export function payingOff(opts: { runs: MilestoneRun[]; vdot: VdotPoint[]; ef: EfPoint[]; today: string }): Payoff {
  const { today } = opts;
  const thisWeek = weekStart(today);
  // whole weeks: the current week counts as part of the recent block
  const recentFrom = addDaysIso(thisWeek, -7 * (BLOCK_WEEKS - 1));
  const priorFrom = addDaysIso(recentFrom, -7 * BLOCK_WEEKS);
  const recent = opts.runs.filter((r) => r.date >= recentFrom && r.date <= today);
  const prior = opts.runs.filter((r) => r.date >= priorFrom && r.date < recentFrom);
  const before = opts.runs.filter((r) => r.date < recentFrom);
  const items: PayoffItem[] = [];
  const base = { from: recentFrom, to: today };

  if (recent.length < 4) {
    return {
      ...base,
      state: "not_enough_data",
      headline: "Not enough recent running to judge",
      summary: `${recent.length} run${recent.length === 1 ? "" : "s"} in the last ${BLOCK_WEEKS} weeks. Trends appear after a few more; short breaks are normal and fitness comes back faster than it was first built.`,
      items,
    };
  }

  // fitness estimate: now vs the start of the block
  const v = opts.vdot.filter((p): p is { date: string; value: number } => p.value != null).sort((a, b) => a.date.localeCompare(b.date));
  const vNow = v.at(-1);
  const vThen = [...v].reverse().find((p) => p.date <= recentFrom);
  if (vNow && vThen && vNow.date > recentFrom) {
    const d = vNow.value - vThen.value;
    items.push({
      key: "vdot",
      tone: d >= 0.5 ? "good" : d <= -0.5 ? "down" : "steady",
      title: d >= 0.5 ? `Fitness up ${d.toFixed(1)} VDOT` : d <= -0.5 ? `Fitness down ${Math.abs(d).toFixed(1)} VDOT` : "Fitness estimate holding",
      detail: `${vThen.value.toFixed(1)} → ${vNow.value.toFixed(1)}${d >= 0.5 ? ", which takes about " + fmtTime(Math.abs(fiveKDelta(vThen.value, vNow.value))) + " off a 5 km" : ""}`,
      basis: "Weekly VDOT estimate at the start of the block and now, each computed only from runs before that date.",
    });
  }

  // aerobic efficiency: speed per heartbeat on easy/steady runs
  const efRecent = median(opts.ef.filter((p) => p.date >= addDaysIso(today, -28)).map((p) => p.ef));
  const efThen = median(opts.ef.filter((p) => p.date < recentFrom && p.date >= addDaysIso(recentFrom, -28)).map((p) => p.ef));
  const efN = opts.ef.filter((p) => p.date >= addDaysIso(today, -28)).length;
  if (efRecent != null && efThen != null && efN >= 2) {
    const d = pct(efRecent, efThen);
    items.push({
      key: "efficiency",
      tone: d >= 2 ? "good" : d <= -2 ? "down" : "steady",
      title: d >= 2 ? `${d.toFixed(0)} % more speed for the same heart rate` : d <= -2 ? `${Math.abs(d).toFixed(0)} % less speed for the same heart rate` : "Aerobic efficiency steady",
      detail:
        d >= 2
          ? "Your easy runs are faster at the same effort: the clearest sign of a better aerobic base."
          : d <= -2
            ? "Heat, hills, fatigue or illness can all cause this; one block isn't a trend."
            : "Easy runs cost about the same heart rate as before.",
      basis: "Median metres per minute per heartbeat on easy and steady runs, last 4 weeks vs the 4 weeks before this block.",
    });
  }

  // volume
  const km = (rs: MilestoneRun[]) => rs.reduce((s, r) => s + (r.distanceM ?? 0), 0) / 1000 / BLOCK_WEEKS;
  if (prior.length) {
    const a = km(recent);
    const b = km(prior);
    const d = pct(a, b);
    items.push({
      key: "volume",
      tone: d >= 10 ? "good" : d <= -20 ? "down" : "steady",
      title: d >= 10 ? `Running ${d.toFixed(0)} % more` : d <= -20 ? `Running ${Math.abs(d).toFixed(0)} % less` : "Weekly volume steady",
      detail: `${b.toFixed(1)} → ${a.toFixed(1)} km a week`,
      basis: `Average weekly distance over the last ${BLOCK_WEEKS} weeks vs the ${BLOCK_WEEKS} before.`,
    });
  }

  // consistency
  const weeksWith = (rs: MilestoneRun[]) => new Set(rs.map((r) => weekStart(r.date))).size;
  const cNow = weeksWith(recent);
  const cThen = weeksWith(prior);
  items.push({
    key: "consistency",
    tone: cNow >= 7 || cNow > cThen + 1 ? "good" : cNow < cThen - 1 ? "down" : "steady",
    title: `Ran in ${cNow} of ${BLOCK_WEEKS} weeks`,
    detail: prior.length ? `${cThen} of ${BLOCK_WEEKS} in the block before` : "consistency is what builds fitness",
    basis: "Weeks with at least one run.",
  });

  // long run
  const longest = (rs: MilestoneRun[]) => Math.max(0, ...rs.map((r) => r.distanceM ?? 0));
  if (prior.length) {
    const a = longest(recent);
    const b = longest(prior);
    if (a >= b * 1.1 && a - b >= 1000)
      items.push({ key: "long_run", tone: "good", title: `Longest run up to ${fmtDist(a)}`, detail: `from ${fmtDist(b)} in the block before`, basis: "Longest single run in each block." });
  }

  // new best efforts this block
  const newBests: string[] = [];
  for (const d of [1000, 5000, 10_000, 21_097.5]) {
    const bestBefore = Math.min(Infinity, ...before.flatMap((r) => r.bestEfforts.filter((e) => Math.abs(e.distanceM - d) < 1).map((e) => e.timeS)));
    const bestNow = Math.min(Infinity, ...recent.flatMap((r) => r.bestEfforts.filter((e) => Math.abs(e.distanceM - d) < 1).map((e) => e.timeS)));
    if (Number.isFinite(bestNow) && Number.isFinite(bestBefore) && bestNow < bestBefore) newBests.push(`${fmtDist(d)} ${fmtTime(bestNow)} (−${fmtTime(bestBefore - bestNow)})`);
  }
  if (newBests.length)
    items.push({
      key: "best_effort",
      tone: "good",
      title: newBests.length === 1 ? "New best effort" : `${newBests.length} new best efforts`,
      detail: newBests.join(", "),
      basis: "Fastest stretch within any run with reliable GPS, compared with everything imported before this block.",
    });

  const good = items.filter((i) => i.tone === "good");
  const down = items.filter((i) => i.tone === "down");
  const fitnessDown = items.some((i) => (i.key === "vdot" || i.key === "efficiency") && i.tone === "down");
  let state: Payoff["state"];
  let headline: string;
  let summary: string;
  if (good.length && good.length >= down.length) {
    state = "paying_off";
    headline = "Your training is paying off";
    const cause = items.find((i) => (i.key === "volume" || i.key === "consistency") && i.tone === "good");
    const effect = items.find((i) => (i.key === "vdot" || i.key === "efficiency" || i.key === "best_effort") && i.tone === "good");
    summary =
      cause && effect
        ? `${cause.title.replace(/^Ran in/, "Running in")} has come with ${lowerFirst(effect.title)}. That's the training doing its work.`
        : `${good.length} sign${good.length === 1 ? "" : "s"} of progress over the last ${BLOCK_WEEKS} weeks.`;
  } else if (fitnessDown || down.length > good.length) {
    state = "dipped";
    headline = "A dip, not a verdict";
    const lessRunning = items.some((i) => (i.key === "volume" || i.key === "consistency") && i.tone === "down");
    summary = lessRunning
      ? "Less running in this block explains most of it. Fitness built over months fades slowly and returns quickly once you're back to your usual weeks."
      : "Your running held up, so this may be fatigue, heat or a few off days. Watch the next couple of weeks before reading much into it.";
  } else {
    state = "steady";
    headline = "Holding steady";
    summary = "No big changes either way over the last block. Steady training is still banking fitness, even when the numbers sit still.";
  }
  return { ...base, state, headline, summary, items };
}

const fiveKDelta = (a: number, b: number) => predictTimeS(a, 5000) - predictTimeS(b, 5000);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
