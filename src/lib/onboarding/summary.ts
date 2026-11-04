/**
 * Baseline summary for onboarding: what the imported history shows, as plain
 * statements tied to a number, split into strengths and areas worth developing.
 * Pure. Only says what the data supports; thin data is said to be thin.
 */
import type { Baseline } from "../planning/types";

export interface SummaryInput {
  baseline: Baseline;
  /** % change per 30 days in easy-run efficiency, when the model supports one */
  efficiencyChangePer30dPct: number | null;
  /** days between the first imported run and today */
  historyDays: number;
  runCount: number;
  maxHrSource: "manual" | "observed" | "age_formula" | null;
}

export interface Point {
  title: string;
  detail: string;
}

export interface BaselineSummary {
  strengths: Point[];
  develop: Point[];
  /** limits of the data itself */
  caveats: Point[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summarizeBaseline(s: SummaryInput): BaselineSummary {
  const b = s.baseline;
  const strengths: Point[] = [];
  const develop: Point[] = [];
  const caveats: Point[] = [];
  const weeksRun = Math.round(b.consistency * 8);

  if (s.runCount === 0) {
    caveats.push({ title: "No runs yet", detail: "There is nothing to build a baseline from. Import more history, or start running and Løype will learn as you go." });
    return { strengths, develop, caveats };
  }

  // consistency
  if (weeksRun >= 6) strengths.push({ title: "Consistent", detail: `You ran in ${weeksRun} of the last 8 weeks. Regular weeks are what fitness is built on.` });
  else if (weeksRun <= 4)
    develop.push({ title: "Consistency", detail: `You ran in ${weeksRun} of the last 8 weeks. Running most weeks matters more than any single big week.` });

  // frequency
  if (b.runsPerWeek >= 3) strengths.push({ title: "Run often", detail: `About ${b.runsPerWeek.toFixed(1)} runs a week over the last 4 weeks.` });
  else if (b.runsPerWeek > 0 && b.runsPerWeek < 2.5)
    develop.push({
      title: "Frequency",
      detail: `About ${b.runsPerWeek.toFixed(1)} runs a week. Adding a short easy run is the gentlest way to build aerobic fitness.`,
    });

  // endurance
  if (b.longestRunMinutes >= 75) strengths.push({ title: "Endurance base", detail: `Your longest run in the last 8 weeks was ${b.longestRunMinutes} min.` });
  else if (b.longestRunMinutes > 0 && b.longestRunMinutes < 50)
    develop.push({
      title: "Long run",
      detail: `Your longest run in the last 8 weeks was ${b.longestRunMinutes} min. Extending one run a week, a few minutes at a time, builds endurance.`,
    });

  // fitness signal
  if (b.vdot != null && (b.vdotConfidence === "high" || b.vdotConfidence === "medium")) {
    const t = b.paceZones?.find((z) => z.key === "threshold");
    const pace = t ? ` Threshold pace is about ${fmtPace(t.fastSPerKm)}–${fmtPace(t.slowSPerKm)}/km.` : "";
    strengths.push({ title: "Clear fitness signal", detail: `Your hard efforts put you at VDOT ${b.vdot.toFixed(1)} (${b.vdotConfidence} confidence).${pace}` });
  } else if (b.vdot != null) {
    caveats.push({ title: "Rough fitness estimate", detail: `VDOT ${b.vdot.toFixed(1)}, low confidence. A race or 5 km time trial would firm it up.` });
  } else {
    develop.push({
      title: "Fitness benchmark",
      detail: "No run was hard and steady enough to estimate fitness. A race or 5 km time trial gives Løype a reliable number for your paces.",
    });
  }

  // aerobic efficiency
  const ef = s.efficiencyChangePer30dPct;
  if (ef != null && ef >= 1) strengths.push({ title: "Getting more efficient", detail: `Easy runs are ${ef.toFixed(1)}% more efficient per month (pace per heartbeat).` });
  else if (ef != null && ef <= -1)
    develop.push({ title: "Aerobic efficiency", detail: `Easy runs have become ${Math.abs(ef).toFixed(1)}% less efficient per month. Often fatigue, heat or illness; worth watching.` });

  // data limits
  if (s.historyDays < 84)
    caveats.push({
      title: "Short history",
      detail: `Only ${plural(Math.max(1, Math.round(s.historyDays / 7)), "week")} of runs. 12–16 weeks or more gives a much steadier baseline.`,
    });
  if (s.maxHrSource !== "manual" && s.maxHrSource !== "observed")
    caveats.push({ title: "Max heart rate is estimated", detail: "Zones and training load scale with it. Enter it on the next step if you know it." });

  return { strengths, develop, caveats };
}

function fmtPace(s: number): string {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}
