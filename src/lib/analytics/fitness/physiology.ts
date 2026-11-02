/**
 * Max and resting heart rate: the two anchors every HR-based number needs.
 * Order of preference is always: what you entered > what was measured >
 * a documented proxy. Population formulas (e.g. 208 − 0.7·age) are only used
 * when nothing was measured, and are labelled as such.
 */
import { addDaysIso } from "../../dates";

export type MaxHrSource = "manual" | "observed" | "age_formula";
export type RestHrSource = "manual" | "garmin" | "overnight_proxy";

export interface Physiology {
  maxHr: { value: number; source: MaxHrSource; note: string } | null;
  restHr: { value: number; source: RestHrSource; note: string } | null;
  /** Banister TRIMP weighting; female constants when profile says female, else the male constants. */
  trimpK: { a: number; b: number; note: string };
}

export interface ProfileInput {
  max_hr: number | null;
  max_hr_source: string | null;
  resting_hr: number | null;
  resting_hr_source: string | null;
  birth_year: number | null;
  sex: string | null;
}

export interface WellnessPoint {
  date: string;
  metric: string;
  value: number | null;
}

export interface MaxHrEvidence {
  activityId: string;
  date: string;
  maxSustainedHr: number | null;
  hrReliable: boolean;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function derivePhysiology(
  asOf: string,
  profile: ProfileInput | null,
  runs: MaxHrEvidence[],
  wellness: WellnessPoint[],
): Physiology {
  return {
    maxHr: deriveMaxHr(asOf, profile, runs),
    restHr: deriveRestHr(asOf, profile, wellness),
    trimpK:
      profile?.sex === "female"
        ? { a: 0.86, b: 1.67, note: "Banister TRIMP, female weighting" }
        : { a: 0.64, b: 1.92, note: profile?.sex === "male" ? "Banister TRIMP, male weighting" : "Banister TRIMP, male weighting (set sex in your profile to change)" },
  };
}

function deriveMaxHr(asOf: string, profile: ProfileInput | null, runs: MaxHrEvidence[]): Physiology["maxHr"] {
  if (profile?.max_hr && profile.max_hr_source === "manual") {
    return { value: profile.max_hr, source: "manual", note: "Entered by you" };
  }
  // Highest 10-s mean HR over the last 2 years of runs with trustworthy HR.
  // A single highest value can still be an artefact, so with ≥ 3 runs we take the second highest.
  const from = addDaysIso(asOf, -730);
  const vals = runs
    .filter((r) => r.hrReliable && r.maxSustainedHr != null && r.date >= from && r.date <= asOf)
    .map((r) => r.maxSustainedHr!)
    .filter((v) => v >= 120 && v <= 225)
    .sort((a, b) => b - a);
  if (vals.length) {
    const v = Math.round(vals.length >= 3 ? vals[1] : vals[0]);
    return {
      value: v,
      source: "observed",
      note: `Highest sustained heart rate seen in your runs (${vals.length >= 3 ? "second-highest of " + vals.length + " runs, to skip artefacts" : "few runs"}). Your true maximum is likely a bit higher unless you have run all-out.`,
    };
  }
  if (profile?.birth_year) {
    const age = Number(asOf.slice(0, 4)) - profile.birth_year;
    return { value: Math.round(208 - 0.7 * age), source: "age_formula", note: "Tanaka formula 208 − 0.7 × age; individual error is often ±10 bpm" };
  }
  return null;
}

function deriveRestHr(asOf: string, profile: ProfileInput | null, wellness: WellnessPoint[]): Physiology["restHr"] {
  if (profile?.resting_hr && profile.resting_hr_source === "manual") {
    return { value: profile.resting_hr, source: "manual", note: "Entered by you" };
  }
  const from = addDaysIso(asOf, -30);
  const recent = (metric: string) =>
    wellness.filter((w) => w.metric === metric && w.value != null && w.value >= 25 && w.value <= 120 && w.date > from && w.date <= asOf).map((w) => w.value!);
  const garmin = recent("resting_hr");
  if (garmin.length >= 5) {
    return { value: Math.round(median(garmin)), source: "garmin", note: `Median of Garmin's daily resting HR over the last 30 days (${garmin.length} days)` };
  }
  const sleep = recent("sleep_avg_hr");
  if (sleep.length >= 5) {
    return {
      value: Math.round(median(sleep)),
      source: "overnight_proxy",
      note: `Median overnight average HR over the last 30 days (${sleep.length} nights). Used because Garmin's resting HR isn't available; it is usually within a few bpm of it.`,
    };
  }
  return null;
}

/** Fraction of heart-rate reserve, clamped to 0..1.05. */
export function hrrFraction(hr: number, p: Physiology): number | null {
  if (!p.maxHr || !p.restHr || p.maxHr.value <= p.restHr.value) return null;
  return Math.max(0, Math.min(1.05, (hr - p.restHr.value) / (p.maxHr.value - p.restHr.value)));
}

export interface HrZone {
  zone: 1 | 2 | 3 | 4 | 5;
  label: string;
  minBpm: number;
  maxBpm: number;
}

/** Karvonen (heart-rate-reserve) zones: 50–60, 60–70, 70–80, 80–90, 90–100 %. */
export function hrZones(p: Physiology): HrZone[] | null {
  if (!p.maxHr || !p.restHr) return null;
  const r = p.restHr.value;
  const span = p.maxHr.value - r;
  const at = (f: number) => Math.round(r + f * span);
  const labels = ["Recovery", "Easy aerobic", "Steady", "Threshold", "VO2max"];
  return [0.5, 0.6, 0.7, 0.8, 0.9].map((f, i) => ({
    zone: (i + 1) as HrZone["zone"],
    label: labels[i],
    minBpm: at(f),
    maxBpm: i === 4 ? p.maxHr!.value : at(f + 0.1) - 1,
  }));
}
