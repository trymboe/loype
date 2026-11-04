/**
 * Per-rep analysis of an interval session: finds the work bouts (from the
 * watch's laps when they line up with the plan, otherwise from the speed
 * stream), then measures each rep and the patterns across them: pacing
 * consistency, fade, heart-rate drift and heart-rate recovery between reps.
 * Pure. Only measured values are reported; when the reps can't be found
 * reliably, nothing is reported.
 */
import { formatPace } from "../units";
import type { Step, Target } from "./types";

export interface StreamLike {
  t: number[];
  speed: (number | null)[] | null;
  hr: (number | null)[] | null;
  distance: (number | null)[] | null;
}

export interface LapLike {
  start_offset_s: number;
  timer_s: number | null;
  elapsed_s: number | null;
  distance_m: number | null;
  avg_speed: number | null;
  avg_hr: number | null;
  max_hr: number | null;
}

export interface Rep {
  index: number;
  startS: number;
  durationS: number;
  distanceM: number;
  paceSPerKm: number;
  avgHr: number | null;
  /** HR at the end of the rep */
  endHr: number | null;
  /** HR drop in the 60 s after the rep (heart-rate recovery), when there was a recovery that long */
  hrr60: number | null;
  /** within the target pace range (±3 %) */
  onTarget: boolean | null;
}

export interface IntervalAnalysis {
  source: "laps" | "stream";
  planned: number;
  found: number;
  reps: Rep[];
  target: [number, number] | null;
  /** coefficient of variation of rep pace, % */
  paceCvPct: number;
  /** last third vs first third, % slower (positive = faded) */
  fadePct: number;
  /** avg HR of the last third minus the first third, bpm */
  hrDrift: number | null;
  /** heart-rate recovery (60 s) of the first vs last measured rep */
  hrrFirst: number | null;
  hrrLast: number | null;
  notes: string[];
}

const WORK_ZONES = new Set(["marathon", "threshold", "interval", "repetition", "race", "hill"]);

/** The main repeat block and its work step. */
export function mainRepeat(steps: Step[]): { count: number; work: { durationS: number; distanceM?: number; target: Target }; recoveryS: number } | null {
  let best: ReturnType<typeof mainRepeat> = null;
  for (const s of steps) {
    if (s.kind !== "repeat") continue;
    const work = s.steps.find((x) => x.kind === "run" && WORK_ZONES.has(x.target.zone)) as Exclude<Step, { kind: "repeat" }> | undefined;
    if (!work?.durationS) continue;
    const rec = s.steps.filter((x) => x !== work && x.kind !== "repeat").reduce((a, x) => a + ((x as { durationS?: number }).durationS ?? 0), 0);
    if (!best || s.count * work.durationS > best.count * best.work.durationS) best = { count: s.count, work: { durationS: work.durationS, distanceM: work.distanceM, target: work.target }, recoveryS: rec };
  }
  return best && best.count >= 2 ? best : null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Index of the first sample at or after time s. */
function at(t: number[], s: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hrAt(st: StreamLike, s: number): number | null {
  if (!st.hr) return null;
  const i = at(st.t, s);
  // median of a 10 s window, to ride over single-sample spikes
  const w = st.hr.slice(Math.max(0, i - 5), i + 5).filter((x): x is number => x != null && x > 30);
  if (!w.length) return null;
  const sorted = [...w].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function avgHrBetween(st: StreamLike, a: number, b: number): number | null {
  if (!st.hr) return null;
  const xs = st.hr.slice(at(st.t, a), at(st.t, b)).filter((x): x is number => x != null && x > 30);
  return xs.length ? Math.round(mean(xs)) : null;
}

function bouts(st: StreamLike, workS: number, threshold: number): { a: number; b: number }[] {
  const { t, speed } = st;
  if (!speed) return [];
  // 15 s centred moving average of speed
  const sm: number[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    while (hi < t.length && t[hi] <= t[i] + 7.5) {
      if (speed[hi] != null) {
        sum += speed[hi]!;
        n++;
      }
      hi++;
    }
    while (t[lo] < t[i] - 7.5) {
      if (speed[lo] != null) {
        sum -= speed[lo]!;
        n--;
      }
      lo++;
    }
    sm.push(n ? sum / n : 0);
  }
  const raw: { a: number; b: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < t.length; i++) {
    const above = sm[i] >= threshold;
    if (above && start == null) start = t[i];
    if (!above && start != null) {
      raw.push({ a: start, b: t[i] });
      start = null;
    }
  }
  if (start != null) raw.push({ a: start, b: t[t.length - 1] });
  // merge dips shorter than 10 s (GPS wobble, a corner)
  const merged: { a: number; b: number }[] = [];
  for (const r of raw) {
    const last = merged.at(-1);
    if (last && r.a - last.b < 10) last.b = r.b;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.b - r.a >= workS * 0.5 && r.b - r.a <= workS * 1.8);
}

function distanceBetween(st: StreamLike, a: number, b: number): number {
  const i = at(st.t, a);
  const j = at(st.t, b);
  const d = st.distance;
  if (d && d[i] != null && d[j] != null && d[j]! > d[i]!) return d[j]! - d[i]!;
  let m = 0;
  for (let k = i + 1; k <= j && k < st.t.length; k++) m += (st.speed?.[k] ?? 0) * (st.t[k] - st.t[k - 1]);
  return m;
}

export function analyzeIntervals(steps: Step[], stream: StreamLike | null, laps: LapLike[] = []): IntervalAnalysis | null {
  const plan = mainRepeat(steps);
  if (!plan || !stream || stream.t.length < 60) return null;
  const W = plan.work.durationS;
  const tgt: [number, number] | null = plan.work.target.paceFast != null && plan.work.target.paceSlow != null ? [plan.work.target.paceFast, plan.work.target.paceSlow] : null;

  // 1. laps that look like the work bouts: right length and faster than the laps around them
  let found: { a: number; b: number }[] = [];
  let source: IntervalAnalysis["source"] = "laps";
  const lapDur = (l: LapLike) => l.timer_s ?? l.elapsed_s ?? 0;
  const sized = laps.filter((l) => lapDur(l) >= W * 0.7 && lapDur(l) <= W * 1.4 && (l.avg_speed ?? 0) > 0);
  if (sized.length >= 2 && laps.length >= sized.length + 1) {
    const medianSpeed = [...laps.map((l) => l.avg_speed ?? 0)].sort((a, b) => a - b)[Math.floor(laps.length / 2)];
    const fast = sized.filter((l) => (l.avg_speed ?? 0) > medianSpeed * 1.05);
    if (fast.length >= Math.min(2, plan.count) && fast.length <= plan.count + 1) found = fast.map((l) => ({ a: l.start_offset_s, b: l.start_offset_s + lapDur(l) }));
  }
  // 2. otherwise from the speed stream
  if (found.length < 2) {
    source = "stream";
    const sp = (stream.speed ?? []).filter((x): x is number => x != null && x > 0.5).sort((a, b) => a - b);
    if (sp.length < 60) return null;
    const workSpeed = tgt ? 1000 / ((tgt[0] + tgt[1]) / 2) : sp[Math.floor(sp.length * 0.9)];
    const easySpeed = sp[Math.floor(sp.length * 0.25)];
    if (workSpeed <= easySpeed * 1.08) return null; // no clear contrast between work and recovery
    found = bouts(stream, W, (workSpeed + easySpeed) / 2);
    if (found.length > plan.count) {
      // keep the plan's number of bouts: the fastest ones, back in time order
      const pace = (r: { a: number; b: number }) => distanceBetween(stream, r.a, r.b) / (r.b - r.a);
      found = [...found]
        .sort((x, y) => pace(y) - pace(x))
        .slice(0, plan.count)
        .sort((x, y) => x.a - y.a);
    }
  }
  if (found.length < 2) return null;

  const reps: Rep[] = found.map((r, i) => {
    const dur = r.b - r.a;
    const dist = distanceBetween(stream, r.a, r.b);
    const pace = dist > 0 ? dur / (dist / 1000) : 0;
    const endHr = hrAt(stream, r.b);
    const next = found[i + 1];
    const after = hrAt(stream, r.b + 60);
    const hrr60 = endHr != null && after != null && (!next || next.a - r.b >= 55) && r.b + 60 <= stream.t[stream.t.length - 1] ? Math.round(endHr - after) : null;
    return {
      index: i + 1,
      startS: Math.round(r.a),
      durationS: Math.round(dur),
      distanceM: Math.round(dist),
      paceSPerKm: Math.round(pace),
      avgHr: avgHrBetween(stream, r.a + Math.min(30, dur / 3), r.b),
      endHr: endHr != null ? Math.round(endHr) : null,
      hrr60,
      onTarget: tgt ? pace >= tgt[0] * 0.97 && pace <= tgt[1] * 1.03 : null,
    };
  });

  const paces = reps.map((r) => r.paceSPerKm).filter((p) => p > 0);
  const m = mean(paces);
  const cv = Math.sqrt(mean(paces.map((p) => (p - m) ** 2))) / m;
  const third = Math.max(1, Math.floor(reps.length / 3));
  const first = reps.slice(0, third);
  const last = reps.slice(-third);
  const fadePct = (mean(last.map((r) => r.paceSPerKm)) / mean(first.map((r) => r.paceSPerKm)) - 1) * 100;
  const hrs = (rs: Rep[]) => rs.map((r) => r.avgHr).filter((x): x is number => x != null);
  const hrDrift = hrs(first).length && hrs(last).length ? Math.round(mean(hrs(last)) - mean(hrs(first))) : null;
  const hrr = reps.filter((r) => r.hrr60 != null);
  const a: IntervalAnalysis = {
    source,
    planned: plan.count,
    found: reps.length,
    reps,
    target: tgt,
    paceCvPct: Math.round(cv * 1000) / 10,
    fadePct: Math.round(fadePct * 10) / 10,
    hrDrift,
    hrrFirst: hrr[0]?.hrr60 ?? null,
    hrrLast: hrr.length > 1 ? hrr.at(-1)!.hrr60 : null,
    notes: [],
  };
  a.notes = intervalNotes(a);
  return a;
}

/** Plain-language reading of the numbers. Thresholds are rules of thumb, stated in the text. */
export function intervalNotes(a: IntervalAnalysis): string[] {
  const n: string[] = [];
  if (a.found < a.planned) n.push(`${a.found} of ${a.planned} reps found in the recording.`);
  if (a.target) {
    const on = a.reps.filter((r) => r.onTarget).length;
    const fast = a.reps.filter((r) => r.paceSPerKm < a.target![0] * 0.97).length;
    const slow = a.reps.filter((r) => r.paceSPerKm > a.target![1] * 1.03).length;
    n.push(`${on} of ${a.found} reps on target (${formatPace(a.target[0])}–${formatPace(a.target[1])}/km)${fast ? `, ${fast} faster` : ""}${slow ? `, ${slow} slower` : ""}.`);
  }
  if (a.paceCvPct <= 2) n.push(`Very even pacing: rep paces varied by only ${a.paceCvPct} %.`);
  else if (a.paceCvPct > 4) n.push(`Uneven pacing: rep paces varied by ${a.paceCvPct} %. Steadier reps give the same training effect with less fatigue.`);
  if (a.fadePct >= 3) {
    const startedFast = a.target && a.reps[0].paceSPerKm < a.target[0] * 0.97;
    n.push(`The last reps were ${a.fadePct} % slower than the first${startedFast ? ", after a first rep faster than target. Starting at target pace usually avoids the fade" : ". A fade like this usually means the target was a bit ambitious for the day or you were carrying fatigue"}.`);
  } else if (a.fadePct <= -3) n.push(`You got faster through the session (last reps ${Math.abs(a.fadePct)} % quicker): good control, and a sign the target may be conservative.`);
  if (a.hrDrift != null && a.hrDrift >= 8 && a.fadePct < 3) n.push(`Heart rate rose ${a.hrDrift} bpm from the first to the last reps at similar pace: normal cardiac drift, more of it means more accumulated fatigue or heat.`);
  if (a.hrrFirst != null && a.hrrLast != null && a.hrrFirst >= 15 && a.hrrLast < a.hrrFirst * 0.7)
    n.push(`Heart rate recovered less between later reps (${a.hrrFirst} → ${a.hrrLast} bpm in 60 s), a sign fatigue was building.`);
  return n;
}
