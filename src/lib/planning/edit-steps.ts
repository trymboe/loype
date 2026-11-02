/**
 * Editing a planned workout's steps: validates what you typed, rebuilds the
 * pace/HR targets from your zones (or your own pace), and checks the result
 * against the same safety rules the planner uses. Pure.
 */
import { z } from "zod";
import { formatPace } from "../units";
import { SPIKE_MAX } from "./generator";
import { WORKOUT_LABEL, isHard, type Step, type Target, type WorkoutType, type Zone } from "./types";
import { stepsDistance, stepsDuration, target, type TargetContext } from "./workouts";

export const ZONES: Zone[] = ["recovery", "easy", "steady", "marathon", "threshold", "interval", "repetition", "race", "hill"];

const simple = z.object({
  kind: z.enum(["warmup", "cooldown", "run", "recover"]),
  durationS: z.number().int().min(10).max(6 * 3600).optional(),
  distanceM: z.number().min(50).max(60_000).optional(),
  zone: z.enum(ZONES as [Zone, ...Zone[]]),
  /** your own pace range (s/km), overriding the zone's */
  paceFast: z.number().min(150).max(900).optional(),
  paceSlow: z.number().min(150).max(900).optional(),
  note: z.string().max(140).optional(),
});
export type EditableSimple = z.infer<typeof simple>;
export type EditableStep = EditableSimple | { kind: "repeat"; count: number; steps: EditableSimple[] };

export const editableSteps = z
  .array(z.union([simple, z.object({ kind: z.literal("repeat"), count: z.number().int().min(1).max(40), steps: z.array(simple).min(1).max(6) })]))
  .min(1)
  .max(20);

/** The planned steps as editable values (zone + optional own pace). */
export function toEditable(steps: Step[]): EditableStep[] {
  const one = (s: Exclude<Step, { kind: "repeat" }>): EditableSimple => ({
    kind: s.kind,
    ...(s.durationS != null ? { durationS: Math.round(s.durationS) } : {}),
    ...(s.distanceM != null ? { distanceM: s.distanceM } : {}),
    zone: s.target.zone,
    ...(s.target.paceFast != null && s.target.paceSlow != null && s.target.label.includes("(your pace)") ? { paceFast: s.target.paceFast, paceSlow: s.target.paceSlow } : {}),
    ...(s.note ? { note: s.note } : {}),
  });
  return steps.map((s) => (s.kind === "repeat" ? { kind: "repeat" as const, count: s.count, steps: s.steps.filter((x) => x.kind !== "repeat").map((x) => one(x as Exclude<Step, { kind: "repeat" }>)) } : one(s)));
}

function targetFor(s: EditableSimple, ctx: TargetContext): Target {
  const t = target(s.zone, ctx);
  if (s.paceFast == null || s.paceSlow == null) return t;
  const [fast, slow] = s.paceFast <= s.paceSlow ? [s.paceFast, s.paceSlow] : [s.paceSlow, s.paceFast];
  const name = t.label.split(" · ")[0];
  const hr = t.hrMin != null && t.hrMax != null ? ` · HR ${t.hrMin}–${t.hrMax}` : "";
  return { ...t, paceFast: Math.round(fast), paceSlow: Math.round(slow), label: `${name} ${formatPace(fast)}–${formatPace(slow)}/km (your pace)${hr}` };
}

/** Builds steps with targets. A distance step gets an estimated time from its pace so totals stay right. */
export function rebuildSteps(input: EditableStep[], ctx: TargetContext): Step[] {
  const one = (s: EditableSimple): Step => {
    const t = targetFor(s, ctx);
    const mid = t.paceFast != null && t.paceSlow != null ? (t.paceFast + t.paceSlow) / 2 : null;
    let durationS = s.durationS;
    if (s.distanceM != null && mid != null) durationS = Math.round((s.distanceM / 1000) * mid);
    if (durationS == null) throw new Error(`A ${s.kind} step at ${t.label.split(" · ")[0].toLowerCase()} has no pace, so give it a time instead of a distance.`);
    return { kind: s.kind, durationS, ...(s.distanceM != null ? { distanceM: s.distanceM } : {}), target: t, ...(s.note ? { note: s.note } : {}) };
  };
  return input.map((s) => (s.kind === "repeat" ? { kind: "repeat", count: s.count, steps: s.steps.map(one) } : one(s)));
}

const HARD_ZONES: Zone[] = ["threshold", "interval", "repetition", "race", "hill"];
const fmtMin = (s: number) => (s % 60 === 0 ? `${s / 60} min` : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

/** A title in the planner's style, e.g. "5 × 4 min interval" or "45 min easy". */
export function titleFor(type: WorkoutType, steps: Step[]): string {
  const rep = steps.find((s) => s.kind === "repeat") as Extract<Step, { kind: "repeat" }> | undefined;
  const work = rep?.steps.find((s) => s.kind === "run") as Exclude<Step, { kind: "repeat" }> | undefined;
  if (rep && work) return `${rep.count} × ${work.distanceM ? fmtDist(work.distanceM) : fmtMin(work.durationS ?? 0)} ${work.target.label.split(" · ")[0].replace(/ \d.*$/, "").toLowerCase()}`;
  return `${Math.round(stepsDuration(steps) / 60)} min ${WORKOUT_LABEL[type].toLowerCase()}`;
}

/** Minutes at threshold or harder. */
export function hardSeconds(steps: Step[]): number {
  return steps.reduce((a, s) => a + (s.kind === "repeat" ? s.count * hardSeconds(s.steps) : HARD_ZONES.includes(s.target.zone) && s.kind === "run" ? (s.durationS ?? 0) : 0), 0);
}

export interface EditCheck {
  /** longest run in the 30 days before the workout, minutes (real and planned) */
  longest30Min: number;
  /** the rest of the week's planned minutes and hard minutes, without this workout */
  weekOtherMin: number;
  weekOtherHardMin: number;
  /** the zone paces from your fitness, to flag paces faster than it supports */
  ctx: TargetContext;
}

/** Warnings for an edited workout, using the planner's rules. You can save anyway. */
export function editIssues(type: WorkoutType, steps: Step[], c: EditCheck): string[] {
  const out: string[] = [];
  const min = stepsDuration(steps) / 60;
  const cap = Math.max(30, Math.floor(SPIKE_MAX * c.longest30Min));
  if (min > cap)
    out.push(`At ${Math.round(min)} min this run is more than 10 % longer than your longest in the last 30 days (${Math.round(c.longest30Min)} min). Single runs that jump like that are linked to a higher injury risk; ${cap} min or less keeps it within the limit.`);
  const hard = hardSeconds(steps) / 60;
  const weekMin = c.weekOtherMin + min;
  const weekHard = c.weekOtherHardMin + hard;
  if (hard > 0 && weekHard > Math.max(12, weekMin * 0.2) + 3)
    out.push(`This week would have ${Math.round(weekHard)} min at threshold or harder, about ${Math.round((weekHard / weekMin) * 100)} % of its ${Math.round(weekMin)} min. The plan keeps that near 20 % so the hard work can be absorbed.`);
  if (!isHard(type) && hard > 10) out.push("This is planned as an easy day but now has hard running in it. The plan relies on easy days around hard sessions for recovery.");
  // own paces faster than the zone your fitness supports
  const walk = (ss: Step[]) => {
    for (const s of ss) {
      if (s.kind === "repeat") walk(s.steps);
      else if (s.target.label.includes("(your pace)") && s.target.paceFast != null) {
        const zone = target(s.target.zone, c.ctx);
        if (zone.paceFast != null && s.target.paceFast < zone.paceFast * 0.97)
          out.push(`${formatPace(s.target.paceFast)}/km is faster than your current ${zone.label.split(" · ")[0].toLowerCase()} pace (${formatPace(zone.paceFast)}–${formatPace(zone.paceSlow!)}/km). Running it faster than your fitness supports changes what the session trains.`);
      }
    }
  };
  walk(steps);
  return [...new Set(out)];
}

export { stepsDistance, stepsDuration };
