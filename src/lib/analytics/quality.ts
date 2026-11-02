import type { ActivityStreams, NormalizedActivity } from "../fit/types";
import { haversine } from "./geo";
import type { MotionSummary } from "./motion";

/**
 * quality@1 — rule-based data-quality assessment.
 *
 * Outputs separate reliability verdicts for pace and heart rate, plus a
 * `usableForFitness` gate that later fitness models must respect: an activity
 * with unreliable pace or HR is never treated as evidence of a new fitness level.
 */
export type Severity = "info" | "warning" | "critical";

export interface QualityFlag {
  code:
    | "indoor"
    | "no_gps"
    | "gps_spikes"
    | "gps_distance_mismatch"
    | "hr_missing"
    | "hr_dropouts"
    | "hr_cadence_lock"
    | "hr_implausible"
    | "no_elevation"
    | "too_short"
    | "long_stops"
    | "fit_integrity";
  severity: Severity;
  message: string;
}

export interface QualityReport {
  version: "quality@1";
  flags: QualityFlag[];
  gpsCoverage: number; // 0..1
  hrCoverage: number; // 0..1
  paceReliable: boolean;
  hrReliable: boolean;
  usableForFitness: boolean;
  /** 0..1, 1 = no issues. Coarse summary only; use the flags for decisions. */
  score: number;
}

/** Implied speed above which a GPS jump is physically implausible for running. */
export const GPS_SPIKE_SPEED_MS = 12; // 43 km/h

export function assessQuality(a: NormalizedActivity, motion: MotionSummary): QualityReport {
  const s = a.streams;
  const n = s.t.length;
  const flags: QualityFlag[] = [];

  const gpsCount = s.lat.filter((v) => v != null).length;
  const gpsCoverage = n ? gpsCount / n : 0;
  const hrCount = s.hr.filter((v) => v != null).length;
  const hrCoverage = n ? hrCount / n : 0;

  const indoor =
    a.subSport === "treadmill" || a.subSport === "indoor_running" || a.subSport === "indoorRunning" || a.subSport === "virtual_activity";
  let paceReliable = true;
  let hrReliable = true;

  if (a.warnings.some((w) => w.startsWith("FIT integrity"))) {
    flags.push({ code: "fit_integrity", severity: "warning", message: "The file failed its integrity check; some samples may be missing." });
  }

  if (indoor) {
    flags.push({
      code: "indoor",
      severity: "info",
      message: "Indoor/treadmill run: distance and pace come from the watch's accelerometer and can be off by 5–10%.",
    });
    paceReliable = false;
  } else if (gpsCoverage < 0.5) {
    flags.push({ code: "no_gps", severity: "warning", message: "Little or no GPS data; distance and pace may be estimated by the watch." });
    paceReliable = false;
  } else {
    const spikes = countGpsSpikes(s);
    const pairs = Math.max(1, gpsCount - 1);
    if (spikes / pairs > 0.01 || spikes >= 5) {
      flags.push({
        code: "gps_spikes",
        severity: "warning",
        message: `${spikes} GPS jumps implied speeds above ${Math.round(GPS_SPIKE_SPEED_MS * 3.6)} km/h; pace in affected sections is unreliable.`,
      });
      paceReliable = false;
    }
    const gpsDist = gpsPathDistance(s);
    const devDist = motion.distanceSource === "device" ? motion.distance[n - 1] : null;
    if (devDist && devDist > 500 && gpsDist > 0) {
      const ratio = gpsDist / devDist;
      if (ratio > 1.1 || ratio < 0.9) {
        flags.push({
          code: "gps_distance_mismatch",
          severity: "warning",
          message: `GPS track length differs from recorded distance by ${Math.round(Math.abs(ratio - 1) * 100)}%.`,
        });
        paceReliable = false;
      }
    }
  }

  if (hrCoverage < 0.5) {
    flags.push({ code: "hr_missing", severity: "warning", message: "Heart rate missing for most of the run." });
    hrReliable = false;
  } else {
    if (hrCoverage < 0.9) {
      flags.push({ code: "hr_dropouts", severity: "info", message: `Heart rate missing for ${Math.round((1 - hrCoverage) * 100)}% of samples.` });
    }
    if (detectCadenceLock(s)) {
      flags.push({
        code: "hr_cadence_lock",
        severity: "warning",
        message: "Heart rate tracked your cadence for long stretches — a common wrist-sensor artefact. HR-based analysis is unreliable.",
      });
      hrReliable = false;
    }
    const hrVals = s.hr.filter((v): v is number => v != null);
    if (hrVals.some((v) => v > 230 || v < 30)) {
      flags.push({ code: "hr_implausible", severity: "warning", message: "Heart rate contains physiologically implausible values." });
      hrReliable = false;
    }
  }

  if (!indoor && s.altitude.filter((v) => v != null).length < n * 0.5) {
    flags.push({ code: "no_elevation", severity: "info", message: "No elevation data; hill effects cannot be accounted for." });
  }

  const totalDist = motion.distance[n - 1] ?? 0;
  if (motion.movingS < 300 || (totalDist < 1000 && motion.distanceSource !== "none")) {
    flags.push({ code: "too_short", severity: "info", message: "Very short activity; not used as fitness evidence." });
  }

  if (motion.movingS > 0 && motion.stoppedS / (motion.movingS + motion.stoppedS) > 0.15) {
    flags.push({
      code: "long_stops",
      severity: "info",
      message: `Stood still for ${Math.round(motion.stoppedS / 60)} min while the timer ran; moving pace excludes this.`,
    });
  }

  const tooShort = flags.some((f) => f.code === "too_short");
  const usableForFitness = !tooShort && (paceReliable || hrReliable);
  const penalty = flags.reduce((p, f) => p + (f.severity === "critical" ? 0.5 : f.severity === "warning" ? 0.2 : 0.05), 0);

  return {
    version: "quality@1",
    flags,
    gpsCoverage,
    hrCoverage,
    paceReliable,
    hrReliable,
    usableForFitness,
    score: Math.max(0, Math.round((1 - penalty) * 100) / 100),
  };
}

function gpsPoints(s: ActivityStreams): { t: number; lat: number; lng: number }[] {
  const pts: { t: number; lat: number; lng: number }[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const lat = s.lat[i];
    const lng = s.lng[i];
    if (lat != null && lng != null) pts.push({ t: s.t[i], lat, lng });
  }
  return pts;
}

export function countGpsSpikes(s: ActivityStreams): number {
  const pts = gpsPoints(s);
  let spikes = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    const v = haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng) / dt;
    if (v > GPS_SPIKE_SPEED_MS) spikes++;
  }
  return spikes;
}

function gpsPathDistance(s: ActivityStreams): number {
  const pts = gpsPoints(s);
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  return d;
}

/**
 * Cadence lock: optical HR sensors sometimes report step rate instead of
 * heart rate. Flag when HR is within ±3 of cadence (spm) for >25% of samples
 * where both exist and cadence is in running range.
 */
export function detectCadenceLock(s: ActivityStreams): boolean {
  let both = 0;
  let locked = 0;
  for (let i = 0; i < s.t.length; i++) {
    const hr = s.hr[i];
    const cad = s.cadence[i];
    if (hr == null || cad == null || cad < 140) continue;
    both++;
    if (Math.abs(hr - cad) <= 3) locked++;
  }
  return both >= 60 && locked / both > 0.25;
}
