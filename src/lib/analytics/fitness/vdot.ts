/**
 * Daniels & Gilbert running model ("VDOT").
 *
 *   VO2(v)  = -4.60 + 0.182258·v + 0.000104·v²          v in m/min, ml/kg/min
 *   %max(t) = 0.8 + 0.1894393·e^(-0.012778·t) + 0.2989558·e^(-0.1932605·t)   t in min
 *   VDOT    = VO2(d/t) / %max(t)
 *
 * VDOT is a performance index: the VO2max that would explain a race result.
 * It is a model of an athlete trained for the distance, so predictions for
 * distances far beyond the athlete's long runs are optimistic (see
 * endurancePenalty in estimate.ts).
 */

export function vo2AtSpeed(vMetersPerMin: number): number {
  return -4.6 + 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin ** 2;
}

/** Inverse of vo2AtSpeed: speed (m/min) that costs `vo2` ml/kg/min. */
export function speedAtVo2(vo2: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

export function fractionSustainable(minutes: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
}

export function vdotFromPerformance(distanceM: number, timeS: number): number {
  const minutes = timeS / 60;
  return vo2AtSpeed(distanceM / minutes) / fractionSustainable(minutes);
}

/** Race time (s) that a given VDOT predicts for a distance, by bisection. */
export function predictTimeS(vdot: number, distanceM: number): number {
  let lo = distanceM / 400; // 400 m/min ≈ 2:30/km: faster than any VDOT ≤ 85 allows
  let hi = distanceM / 60; // 60 m/min ≈ 16:40/km
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    // higher VDOT needed for a faster time; vdotFromPerformance decreases with time
    if (vdotFromPerformance(distanceM, mid * 60) > vdot) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

export type PaceZoneKey = "easy" | "marathon" | "threshold" | "interval" | "repetition";

export interface PaceZone {
  key: PaceZoneKey;
  label: string;
  /** s/km; fast end and slow end */
  fastSPerKm: number;
  slowSPerKm: number;
  purpose: string;
}

const paceAt = (vdot: number, fraction: number) => 60_000 / speedAtVo2(vdot * fraction);

/**
 * Daniels training intensities as fractions of VO2max:
 * easy 62–70 %, threshold 86–88 %, interval 95–100 %, repetition 105–110 %.
 * Marathon pace comes from the model's marathon prediction (±2 %).
 */
export function trainingPaces(vdot: number): PaceZone[] {
  const mPace = predictTimeS(vdot, 42_195) / 42.195;
  return [
    { key: "easy", label: "Easy", fastSPerKm: paceAt(vdot, 0.7), slowSPerKm: paceAt(vdot, 0.62), purpose: "Most of your running: aerobic base, recovery" },
    { key: "marathon", label: "Marathon", fastSPerKm: mPace * 0.98, slowSPerKm: mPace * 1.02, purpose: "Long steady efforts" },
    { key: "threshold", label: "Threshold", fastSPerKm: paceAt(vdot, 0.88), slowSPerKm: paceAt(vdot, 0.86), purpose: "Comfortably hard, ~20–60 min sustainable" },
    { key: "interval", label: "Interval", fastSPerKm: paceAt(vdot, 1.0), slowSPerKm: paceAt(vdot, 0.95), purpose: "3–5 min repeats at VO2max" },
    { key: "repetition", label: "Repetition", fastSPerKm: paceAt(vdot, 1.1), slowSPerKm: paceAt(vdot, 1.05), purpose: "Short fast reps for speed and economy" },
  ];
}

/** Riegel's endurance formula, used as a cross-check: T2 = T1·(D2/D1)^1.06. */
export function riegel(timeS: number, fromM: number, toM: number, exponent = 1.06): number {
  return timeS * (toM / fromM) ** exponent;
}
