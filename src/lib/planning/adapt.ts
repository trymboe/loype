/**
 * Adaptation rules (`planner@1`). Pure: they look at what happened and
 * propose concrete changes to future workouts. Nothing is applied here; the
 * athlete accepts or keeps the plan, and every accepted change can be undone.
 *
 *  A  fitness moved: re-target future paces
 *  B  missed sessions: ease the coming week back to what you've actually run
 *  C  fatigue signals: turn the next hard session into an easy run
 *  D  return after a break: a gentle week without intensity
 * (A goal change regenerates the plan from today; that is not a proposal.)
 */
import { addDaysIso, daysBetween, formatDay } from "../dates";
import { predictTimeS, trainingPaces } from "../analytics/fitness/vdot";
import { formatPace } from "../units";
import type { Execution } from "./match";
import { isHard, WORKOUT_LABEL, type Baseline, type Goal, type Step, type WorkoutType } from "./types";
import { buildWorkout, stepsDistance, stepsDuration, target, type TargetContext } from "./workouts";

export type Rule = "A" | "B" | "C" | "D";

export interface AdaptWorkout {
  id: string;
  date: string;
  type: WorkoutType;
  title: string;
  objective: string;
  why: string;
  steps: Step[];
  durationS: number;
  distanceM: number | null;
  key: boolean;
  locked: boolean;
  status: string;
  execution: Execution | null;
  rpe: number | null;
}

export interface AdaptRun {
  date: string;
  movingS: number | null;
  classification: string | null;
  rpe: number | null;
  legs: string | null;
}

export interface WorkoutFields {
  type: WorkoutType;
  title: string;
  objective: string;
  why: string;
  steps: Step[];
  durationS: number;
  distanceM: number | null;
}

export interface Change {
  workoutId: string;
  date: string;
  before: WorkoutFields;
  after: WorkoutFields;
}

export interface Proposal {
  rule: Rule;
  /** dedupe key: the same situation never produces two proposals */
  key: string;
  title: string;
  explanation: string;
  evidence: string[];
  changes: Change[];
  /** for rule A: the new baseline numbers to store on the plan when accepted */
  baselinePatch?: { vdot: number; racePace: number | null };
}

export interface AdaptInput {
  today: string;
  goal: Goal;
  baseline: Baseline;
  racePace: number | null;
  raceLabel: string | null;
  workouts: AdaptWorkout[];
  runs: AdaptRun[];
  fitness: { vdot: number; confidence: "high" | "medium" | "low" } | null;
  existingKeys: Set<string>;
}

const fields = (w: AdaptWorkout | WorkoutFields): WorkoutFields => ({
  type: w.type,
  title: w.title,
  objective: w.objective,
  why: w.why,
  steps: w.steps,
  durationS: w.durationS,
  distanceM: w.distanceM,
});

export function retarget(steps: Step[], ctx: TargetContext): Step[] {
  return steps.map((s) => (s.kind === "repeat" ? { ...s, steps: retarget(s.steps, ctx) } : { ...s, target: target(s.target.zone, ctx) }));
}

function easyInstead(w: AdaptWorkout, minutes: number, ctx: TargetContext, why: string): WorkoutFields {
  const b = buildWorkout({ type: "easy", minutes }, ctx);
  return { type: b.type, title: b.title, objective: b.objective, why, steps: b.steps, durationS: stepsDuration(b.steps), distanceM: stepsDistance(b.steps) };
}

function scaled(w: AdaptWorkout, factor: number, ctx: TargetContext, why: string): WorkoutFields {
  const minutes = Math.max(20, Math.round((w.durationS / 60) * factor / 5) * 5);
  const type: WorkoutType = w.type === "progressive_long" ? "long" : w.type === "strides" ? "strides" : w.type === "recovery" ? "recovery" : w.type === "long" ? "long" : "easy";
  const b = buildWorkout({ type, minutes, strides: type === "strides" }, ctx);
  return { type: b.type, title: b.title, objective: b.objective, why, steps: b.steps, durationS: stepsDuration(b.steps), distanceM: stepsDistance(b.steps) };
}

export function proposeAdaptations(input: AdaptInput): Proposal[] {
  const { today } = input;
  const ctx: TargetContext = { baseline: input.baseline, racePace: input.racePace, raceLabel: input.raceLabel };
  const future = input.workouts.filter((w) => w.date >= today && w.status === "planned" && !w.locked && w.type !== "rest" && w.type !== "race");
  const out: Proposal[] = [];
  const push = (p: Proposal) => {
    if (!p.changes.length || input.existingKeys.has(p.key)) return;
    out.push(p);
  };

  // D: return after a break
  const runDates = input.runs.map((r) => r.date).filter((d) => d <= today).sort();
  const lastRun = runDates.at(-1) ?? null;
  const gap = lastRun ? daysBetween(lastRun, today) : null;
  const breakDetected = gap != null && gap >= 12;
  if (breakDetected) {
    const week = future.filter((w) => w.date <= addDaysIso(today, 6));
    push({
      rule: "D",
      key: `D:${lastRun}`,
      title: "Ease back in after the break",
      explanation: `Your last run was ${gap} days ago. After a break, fitness drops a little and tendons lose some tolerance, so this week is shorter (about 55 %) and has no hard sessions. The plan continues as normal after that.`,
      evidence: [`Last recorded run: ${formatDay(lastRun!)}`],
      changes: week.map((w) => ({
        workoutId: w.id,
        date: w.date,
        before: fields(w),
        after: isHard(w.type) ? easyInstead(w, Math.max(20, Math.round((w.durationS / 60) * 0.5)), ctx, "Swapped from a hard session while you get back into running.") : scaled(w, 0.55, ctx, "Shorter while you get back into running."),
      })),
    });
  }

  // B: missed sessions
  const from10 = addDaysIso(today, -10);
  const missed = input.workouts.filter((w) => w.status === "missed" && w.date >= from10 && w.date < today);
  if (!breakDetected && missed.length >= 2) {
    const from7 = addDaysIso(today, -7);
    const actual = input.runs.filter((r) => r.date >= from7 && r.date < today).reduce((a, r) => a + (r.movingS ?? 0) / 60, 0);
    const week = future.filter((w) => w.date <= addDaysIso(today, 6));
    const planned = week.reduce((a, w) => a + w.durationS / 60, 0);
    const allowed = actual * 1.1 + 30;
    if (planned > allowed) {
      const flexible = week.filter((w) => !w.key);
      const fixed = week.filter((w) => w.key).reduce((a, w) => a + w.durationS / 60, 0);
      const flexMin = flexible.reduce((a, w) => a + w.durationS / 60, 0);
      const factor = flexMin > 0 ? Math.max(0.6, Math.min(1, (allowed - fixed) / flexMin)) : 1;
      if (factor < 0.95) {
        push({
          rule: "B",
          key: `B:${missed.map((m) => m.id).sort().join(",")}`,
          title: "Adjust the coming week after missed sessions",
          explanation: `You missed ${missed.length} sessions in the last 10 days and ran ${Math.round(actual)} min in the last 7. Jumping straight back to ${Math.round(planned)} min would be a big step, so the easy runs this week are shortened by ${Math.round((1 - factor) * 100)} %. Key sessions stay; missed sessions are not made up, because stacking them is a common route to injury.`,
          evidence: missed.map((m) => `${formatDay(m.date)}: ${m.title} (missed)`),
          changes: flexible.map((w) => ({ workoutId: w.id, date: w.date, before: fields(w), after: scaled(w, factor, ctx, "Shortened after missed sessions so the week matches what you have been running.") })),
        });
      }
    }
  }

  // C: fatigue signals
  const from3 = addDaysIso(today, -3);
  const recentFeedback = input.runs.filter((r) => r.date >= from3 && r.date <= today);
  const hardEasy = recentFeedback.filter((r) => (r.classification === "easy" || r.classification === "recovery") && (r.rpe ?? 0) >= 8);
  const legs = input.runs
    .filter((r) => r.legs)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-3)
    .filter((r) => r.date >= addDaysIso(today, -7) && (r.legs === "heavy" || r.legs === "sore"));
  if (hardEasy.length || legs.length >= 2) {
    const next = future.filter((w) => isHard(w.type) && w.date <= addDaysIso(today, 3)).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next) {
      const ev = [
        ...hardEasy.map((r) => `${formatDay(r.date)}: easy run rated ${r.rpe}/10`),
        ...(legs.length >= 2 ? legs.map((r) => `${formatDay(r.date)}: legs ${r.legs}`) : []),
      ];
      push({
        rule: "C",
        key: `C:${next.id}`,
        title: `Make ${formatDay(next.date)} an easy run`,
        explanation: `${hardEasy.length ? "An easy run felt hard" : "Your legs have felt heavy or sore"} recently, which often means you haven't recovered. ${WORKOUT_LABEL[next.type]} on ${formatDay(next.date)} becomes an easy run; the rest of the plan is unchanged.`,
        evidence: ev,
        changes: [{ workoutId: next.id, date: next.date, before: fields(next), after: easyInstead(next, Math.min(40, Math.max(25, Math.round(next.durationS / 60 / 1.5))), ctx, "Swapped to easy because of recent fatigue signals.") }],
      });
    }
  }

  // A: fitness moved
  const fromVdot = input.baseline.vdot;
  let newVdot: number | null = null;
  const evidence: string[] = [];
  let reason = "";
  if (input.fitness && fromVdot != null && input.fitness.confidence !== "low" && Math.abs(input.fitness.vdot - fromVdot) >= 1) {
    newVdot = input.fitness.vdot;
    evidence.push(`Fitness estimate: VDOT ${fromVdot.toFixed(1)} when the paces were set, ${newVdot.toFixed(1)} now (${input.fitness.confidence} confidence)`);
    reason = newVdot > fromVdot ? "Your fitness estimate has gone up" : "Your fitness estimate has gone down";
  } else if (fromVdot != null) {
    const done = input.workouts
      .filter((w) => w.status === "completed" && isHard(w.type) && w.execution?.paceDeltaPct != null && w.date < today)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    const strong = done.filter((w) => w.execution!.paceDeltaPct! >= 3 && (w.rpe == null || w.rpe <= 7));
    const withRpe = strong.filter((w) => w.rpe != null).length;
    if (done.length >= 2 && (strong.length >= 2 && (withRpe >= 2 || strong.length === 3))) {
      newVdot = Math.round((fromVdot + 1) * 10) / 10;
      reason = "You have run your recent quality sessions clearly faster than target without them feeling very hard";
      for (const w of strong) evidence.push(`${formatDay(w.date)}: ${w.title}, ${w.execution!.paceDeltaPct!.toFixed(1)} % faster than target${w.rpe != null ? `, RPE ${w.rpe}` : ""}`);
    }
  }
  if (newVdot != null && fromVdot != null) {
    const ratio = predictTimeS(newVdot, 10_000) / predictTimeS(fromVdot, 10_000);
    const goalPace = input.goal.targetTimeS && input.goal.distanceM ? input.goal.targetTimeS / (input.goal.distanceM / 1000) : null;
    const racePace = input.racePace == null ? null : goalPace && Math.abs(goalPace - input.racePace) < 1 ? input.racePace : Math.round(input.racePace * ratio);
    const newCtx: TargetContext = { baseline: { ...input.baseline, vdot: newVdot, paceZones: trainingPaces(newVdot) }, racePace, raceLabel: input.raceLabel };
    const threshold = (b: Baseline) => b.paceZones?.find((z) => z.key === "threshold");
    const t0 = threshold(input.baseline);
    const t1 = threshold(newCtx.baseline);
    push({
      rule: "A",
      key: `A:${fromVdot.toFixed(1)}->${newVdot.toFixed(1)}`,
      title: newVdot > fromVdot ? "Update your paces: you've got fitter" : "Ease your paces to match your current fitness",
      explanation: `${reason}, so future sessions get new pace targets${t0 && t1 ? ` (threshold ${formatPace(t0.fastSPerKm)}–${formatPace(t0.slowSPerKm)} → ${formatPace(t1.fastSPerKm)}–${formatPace(t1.slowSPerKm)}/km)` : ""}. The structure of the plan stays the same.`,
      evidence,
      baselinePatch: { vdot: newVdot, racePace },
      changes: future
        .map((w) => {
          const steps = retarget(w.steps, newCtx);
          return { workoutId: w.id, date: w.date, before: fields(w), after: { ...fields(w), steps, distanceM: stepsDistance(steps) } };
        })
        .filter((c) => JSON.stringify(c.before.steps) !== JSON.stringify(c.after.steps)),
    });
  }
  return out;
}
