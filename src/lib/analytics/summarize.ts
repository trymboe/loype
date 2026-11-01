import type { NormalizedActivity } from "../fit/types";
import { analyzeMotion, elevationGainLoss, type MotionSummary } from "./motion";
import { assessQuality, type QualityReport } from "./quality";
import { computeSplits, type Split } from "./splits";
import { VERSIONS } from "./versions";

export interface ActivitySummary {
  distanceM: number | null;
  elapsedS: number | null;
  timerS: number | null;
  movingS: number;
  avgSpeedMoving: number | null; // m/s over moving time
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  hasGps: boolean;
  isIndoor: boolean;
  /** Where each headline number came from. */
  provenance: Record<string, "device" | "calculated">;
  versions: typeof VERSIONS;
}

export interface DerivedActivity {
  summary: ActivitySummary;
  motion: MotionSummary;
  splits: Split[];
  quality: QualityReport;
}

/** Deterministic derivation of everything we store about an activity. */
export function deriveActivity(a: NormalizedActivity): DerivedActivity {
  const motion = analyzeMotion(a.streams, a.timerEvents);
  const splits = computeSplits(a.streams, motion);
  const quality = assessQuality(a, motion);
  const prov: ActivitySummary["provenance"] = {};

  const pick = <T,>(key: string, device: T | null, calc: T | null): T | null => {
    if (device != null) {
      prov[key] = "device";
      return device;
    }
    if (calc != null) prov[key] = "calculated";
    return calc;
  };

  const lastDist = motion.distance[motion.distance.length - 1];
  const distanceM = pick("distance", a.totals.distanceM, motion.distanceSource !== "none" ? lastDist : null);
  const hrVals = a.streams.hr.filter((v): v is number => v != null);
  const cadVals = a.streams.cadence.filter((v): v is number => v != null && v > 0);
  const elev = elevationGainLoss(a.streams.altitude);
  prov.movingTime = "calculated";

  return {
    motion,
    splits,
    quality,
    summary: {
      distanceM,
      elapsedS: pick("elapsed", a.totals.elapsedS, motion.elapsedS),
      timerS: pick("timer", a.totals.timerS, motion.elapsedS - motion.pausedS),
      movingS: motion.movingS,
      avgSpeedMoving: distanceM != null && motion.movingS > 0 ? distanceM / motion.movingS : null,
      avgHr: pick("avgHr", a.totals.avgHr, hrVals.length ? hrVals.reduce((x, y) => x + y, 0) / hrVals.length : null),
      maxHr: pick("maxHr", a.totals.maxHr, hrVals.length ? Math.max(...hrVals) : null),
      avgCadence: pick("avgCadence", a.totals.avgCadence, cadVals.length ? cadVals.reduce((x, y) => x + y, 0) / cadVals.length : null),
      elevationGainM: pick("elevationGain", a.totals.totalAscentM, elev?.gain ?? null),
      elevationLossM: pick("elevationLoss", a.totals.totalDescentM, elev?.loss ?? null),
      hasGps: quality.gpsCoverage >= 0.5,
      isIndoor: quality.flags.some((f) => f.code === "indoor"),
      provenance: prov,
      versions: VERSIONS,
    },
  };
}
