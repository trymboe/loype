/**
 * Scores one run with the current physiology (`fitness@1`): training load,
 * intensity, aerobic efficiency, HR decoupling, an HR-based VO2max reading
 * and a workout classification. Pure; recomputed whenever max/rest HR change.
 */
import type { RunFeatures } from "./features";
import { hrrFraction, hrZones, type Physiology } from "./physiology";
import { vo2AtSpeed } from "./vdot";

export const MODEL_VERSION = "fitness@1";

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
  /** VO2max implied by the steady HR–speed relationship (Swain: %HRR ≈ %VO2 reserve). */
  vo2maxFromHr: number | null;
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
    const x = hrrFraction(steadyHr, p);
    const hilly = f.steady!.gainPerKm != null && f.steady!.gainPerKm > 20;
    const steadyPacing = f.speedCv == null || f.speedCv < 0.15;
    if (x != null && x >= 0.5 && x <= 0.95 && !hilly && steadyPacing && !run.isIndoor) {
      out.vo2maxFromHr = Math.round((3.5 + (vo2AtSpeed(v) - 3.5) / x) * 10) / 10;
    }
  }

  classify(out, run, f, ctx);
  return finishClass(out, run);
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
