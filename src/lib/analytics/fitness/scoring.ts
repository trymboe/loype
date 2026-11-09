/**
 * Scores one run with the current physiology (`fitness@2`): training load,
 * intensity, aerobic efficiency, HR decoupling, an HR-based VO2max reading
 * and a workout classification. Pure; recomputed whenever max/rest HR change.
 */
import type { RunFeatures, Segment } from "./features";
import { hrrFraction, hrZones, type Physiology } from "./physiology";
import { vo2AtSpeed } from "./vdot";

export const MODEL_VERSION = "fitness@2";

export interface RunRecord {
  id: string;
  date: string; // local date
  name: string | null;
  distanceM: number | null;
  movingS: number | null;
  avgHr: number | null;
  paceReliable: boolean;
  hrReliable: boolean;
  usableForFitness: boolean;
  isIndoor: boolean;
  features: RunFeatures | null;
  classificationOverride: RunClass | null;
  /** linked to a planned time trial */
  plannedTimeTrial?: boolean;
}

export type RunClass = "recovery" | "easy" | "long" | "steady" | "threshold" | "intervals" | "race" | "unknown";

export const RUN_CLASS_LABEL: Record<RunClass, string> = {
  recovery: "Recovery",
  easy: "Easy",
  long: "Long run",
  steady: "Steady",
  threshold: "Threshold",
  intervals: "Intervals",
  race: "Race / time trial",
  unknown: "Unclassified",
};

export interface RunScore {
  trimp: number | null;
  trimpMethod: "hr" | "pace_estimate" | null;
  /** Fraction of HR reserve over the steady part (or estimated from pace when HR is unreliable). */
  intensity: number | null;
  intensitySource: "hr" | "pace" | null;
  /** Efficiency factor: metres per minute per bpm over the steady part. */
  ef: number | null;
  /** HR decoupling, %: drop in efficiency from first to second half. > 5 % on an easy run suggests limited aerobic endurance (or heat, dehydration). */
  decouplingPct: number | null;
  /** VO2max (VDOT scale) implied by this run's HR–speed relationship; see hrSpeedReading. */
  vo2maxFromHr: number | null;
  /** minutes of the run that qualified for that reading */
  vo2maxMinutes: number | null;
  zoneSeconds: number[] | null;
  classification: RunClass;
  classificationConfidence: number;
  classificationReasons: string[];
  classificationManual: boolean;
}

/** Banister TRIMP from the per-bpm histogram. */
export function trimpFromHist(f: RunFeatures, p: Physiology): number | null {
  if (!p.maxHr || !p.restHr || f.hrHist.length === 0) return null;
  let total = 0;
  f.hrHist.forEach((sec, k) => {
    if (!sec) return;
    const x = hrrFraction(f.hrHistOffset + k, p)!;
    total += (sec / 60) * x * p.trimpK.a * Math.exp(p.trimpK.b * x);
  });
  return Math.round(total * 10) / 10;
}

/** TRIMP for a non-running activity from its duration and average HR (Garmin summary only, so less precise). */
export function trimpFromAverage(durationS: number, avgHr: number, p: Physiology): number | null {
  const x = hrrFraction(avgHr, p);
  if (x == null) return null;
  return Math.round((durationS / 60) * x * p.trimpK.a * Math.exp(p.trimpK.b * x) * 10) / 10;
}

const steadySpeedMpm = (f: RunFeatures) => (f.steady && f.steady.movingS > 0 ? (f.steady.distanceM / f.steady.movingS) * 60 : null);

export function scoreRun(run: RunRecord, p: Physiology, ctx: { vdot: number | null; medianRecentMovingS: number | null }): RunScore {
  const f = run.features;
  const out: RunScore = {
    trimp: null,
    trimpMethod: null,
    intensity: null,
    intensitySource: null,
    ef: null,
    decouplingPct: null,
    vo2maxFromHr: null,
    vo2maxMinutes: null,
    zoneSeconds: null,
    classification: "unknown",
    classificationConfidence: 0,
    classificationReasons: [],
    classificationManual: false,
  };
  if (!f) return finishClass(out, run);

  const v = steadySpeedMpm(f);
  const steadyHr = f.steady?.avgHr ?? null;

  // intensity
  if (run.hrReliable && steadyHr != null) {
    const x = hrrFraction(steadyHr, p);
    if (x != null) {
      out.intensity = round3(x);
      out.intensitySource = "hr";
    }
  }
  if (out.intensity == null && run.paceReliable && v != null && ctx.vdot) {
    out.intensity = round3(Math.max(0, Math.min(1.05, (vo2AtSpeed(v) - 3.5) / (ctx.vdot - 3.5))));
    out.intensitySource = "pace";
  }

  // load
  if (run.hrReliable) {
    out.trimp = trimpFromHist(f, p);
    if (out.trimp != null) out.trimpMethod = "hr";
  }
  if (out.trimp == null && out.intensity != null && out.intensitySource === "pace") {
    const x = out.intensity;
    out.trimp = Math.round((f.movingS / 60) * x * p.trimpK.a * Math.exp(p.trimpK.b * x) * 10) / 10;
    out.trimpMethod = "pace_estimate";
  }

  // zones
  const zones = hrZones(p);
  if (zones && run.hrReliable && f.hrHist.length) {
    const z = [0, 0, 0, 0, 0, 0]; // index 0 = below zone 1
    f.hrHist.forEach((sec, k) => {
      const bpm = f.hrHistOffset + k;
      let zi = 0;
      for (const zz of zones) if (bpm >= zz.minBpm) zi = zz.zone;
      z[zi] += sec;
    });
    out.zoneSeconds = z.map((s) => Math.round(s));
  }

  // efficiency, decoupling, VO2max from HR
  const bothReliable = run.hrReliable && run.paceReliable;
  if (bothReliable && v != null && steadyHr != null && f.steady!.movingS >= 900) {
    out.ef = round3(v / steadyHr);
    if (f.halves && f.steady!.movingS >= 1200) {
      const [a, b] = f.halves;
      if (a.avgHr && b.avgHr && a.movingS > 0 && b.movingS > 0) {
        const ef1 = ((a.distanceM / a.movingS) * 60) / a.avgHr;
        const ef2 = ((b.distanceM / b.movingS) * 60) / b.avgHr;
        out.decouplingPct = Math.round(((ef1 - ef2) / ef1) * 1000) / 10;
      }
    }
  }
  if (bothReliable && !run.isIndoor) {
    const r = hrSpeedReading(f.segments ?? [], p);
    if (r) {
      out.vo2maxFromHr = r.vdot;
      out.vo2maxMinutes = r.minutes;
    }
  }

  classify(out, run, f, ctx);
  return finishClass(out, run);
}

/** Minimum qualifying minutes for a per-run reading. */
export const MIN_READING_MINUTES = 6;
/** Extra oxygen cost per unit grade relative to level running (ACSM: 0.9·v·grade vs 0.2·v). */
const GRADE_COST = 4.5;

/**
 * VO2max from the HR–speed relationship of one run, minute by minute.
 *
 * Swain et al. (1994/1997): %HR reserve ≈ %VO2 reserve. With the ACSM running
 * cost, which is linear in speed (VO2 = 3.5 + 0.2·v·(1 + 4.5·grade)), the
 * oxygen reserve used at speed v is proportional to v, so the speed at which
 * HR would reach its maximum (vVO2max) is v_level / %HRR: a straight line
 * from resting HR at standstill through the observed point, extrapolated to
 * max HR. This is the per-run idea behind watch estimates (Firstbeat/Garmin).
 * The reading is put on the VDOT scale with Daniels' oxygen cost at vVO2max,
 * so it is comparable with race-based VDOT.
 *
 * Only minutes where HR has had time to settle count: at least 5 min in, no
 * stop in the last 3 min, speed within ±10 % of the two minutes before and HR
 * within 5 bpm of the minute before. That keeps the steady parts of interval
 * sessions (warm-up, cool-down, longer reps) and drops the reps and
 * recoveries where HR lags speed. Grades over 8 % and HR outside 50–92 % of
 * HR reserve are skipped. The run's reading is the time-weighted median.
 */
export function hrSpeedReading(segs: Segment[], p: Physiology): { vdot: number; minutes: number; spread: number } | null {
  if (!p.maxHr || !p.restHr) return null;
  const byK = new Map(segs.map((s) => [s.k, s]));
  const speed = (s: Segment) => (s.d / s.s) * 60; // m/min
  const ok = (s: Segment | undefined): s is Segment => !!s && s.s >= 50 && s.stopS <= 5;
  const vals: { v: number; w: number }[] = [];
  for (const s of segs) {
    if (s.k < 5 || s.hr == null) continue;
    const a = byK.get(s.k - 2);
    const b = byK.get(s.k - 1);
    if (!ok(s) || !ok(a) || !ok(b) || b.hr == null) continue;
    const v = speed(s);
    if (v < 100) continue; // walking
    if (Math.abs(speed(a) - v) > 0.1 * v || Math.abs(speed(b) - v) > 0.1 * v || Math.abs(b.hr - s.hr) > 5) continue;
    const c = byK.get(s.k + 1);
    let grade = 0;
    if (b.alt != null && c?.alt != null && s.alt != null) grade = (c.alt - b.alt) / (b.d / 2 + s.d + c.d / 2);
    else if (b.alt != null && s.alt != null) grade = (s.alt - b.alt) / (b.d / 2 + s.d / 2);
    if (Math.abs(grade) > 0.08) continue;
    const x = hrrFraction(s.hr, p);
    if (x == null || x < 0.5 || x > 0.92) continue;
    const vMax = (v * (1 + GRADE_COST * grade)) / x;
    vals.push({ v: vo2AtSpeed(vMax), w: s.s });
  }
  if (vals.length < MIN_READING_MINUTES) return null;
  vals.sort((x, y) => x.v - y.v);
  const total = vals.reduce((a, b) => a + b.w, 0);
  let acc = 0;
  let med = vals[vals.length - 1].v;
  for (const i of vals) {
    acc += i.w;
    if (acc >= total / 2) {
      med = i.v;
      break;
    }
  }
  const dev = vals.map((i) => Math.abs(i.v - med)).sort((x, y) => x - y);
  return { vdot: Math.round(med * 10) / 10, minutes: Math.round(total / 60), spread: Math.round(1.4826 * dev[Math.floor(dev.length / 2)] * 10) / 10 };
}

function classify(out: RunScore, run: RunRecord, f: RunFeatures, ctx: { medianRecentMovingS: number | null }) {
  const x = out.intensity;
  const reasons: string[] = [];
  const name = run.name ?? "";
  const mins = f.movingS / 60;
  if (/\b(race|parkrun|konkurranse|stafett|marathon|maraton|halvmaraton|time ?trial)\b/i.test(name)) {
    set(out, "race", 0.8, [`Name "${name}" suggests a race`]);
    return;
  }
  // a planned time trial counts as a race unless the effort was clearly easier than one
  if (run.plannedTimeTrial && (x == null || x >= 0.8)) {
    set(out, "race", 0.8, ["Planned time trial"]);
    return;
  }
  if (x == null) {
    set(out, "unknown", 0, ["No reliable heart rate or pace to judge intensity"]);
    return;
  }
  const pct = Math.round(x * 100);
  const src = out.intensitySource === "hr" ? "of heart-rate reserve" : "intensity estimated from pace";
  if (f.fastBouts >= 4 && (f.speedCv ?? 0) >= 0.12) {
    set(out, "intervals", 0.75, [`${f.fastBouts} fast bouts with variable pace (variation ${Math.round((f.speedCv ?? 0) * 100)} %)`]);
    return;
  }
  if (x >= 0.9 && mins >= 12 && (f.speedCv ?? 0) < 0.1) {
    set(out, "race", 0.55, [`Sustained ${pct} % ${src} for ${Math.round(mins)} min`]);
    return;
  }
  const long = ctx.medianRecentMovingS != null ? f.movingS >= Math.max(75 * 60, 1.4 * ctx.medianRecentMovingS) : f.movingS >= 90 * 60;
  if (long && x < 0.85) {
    reasons.push(`${Math.round(mins)} min, much longer than your typical run`);
    set(out, "long", 0.75, reasons);
    return;
  }
  if (x >= 0.85) return set(out, "threshold", 0.6, [`Steady part at ${pct} % ${src}`]);
  if (x >= 0.77) return set(out, "steady", 0.55, [`Steady part at ${pct} % ${src}: harder than easy, below threshold`]);
  if (x < 0.6 && mins < 45) return set(out, "recovery", 0.6, [`Short and gentle: ${pct} % ${src}`]);
  set(out, "easy", 0.65, [`Steady part at ${pct} % ${src}`]);
}

function set(out: RunScore, c: RunClass, conf: number, reasons: string[]) {
  out.classification = c;
  out.classificationConfidence = conf;
  out.classificationReasons = reasons;
}

function finishClass(out: RunScore, run: RunRecord): RunScore {
  if (run.classificationOverride) {
    out.classification = run.classificationOverride;
    out.classificationConfidence = 1;
    out.classificationManual = true;
    out.classificationReasons = ["Set by you", ...out.classificationReasons];
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
