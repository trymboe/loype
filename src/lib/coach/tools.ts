import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addDaysIso, daysBetween } from "../dates";
import { formatDuration, formatPace } from "../units";
import { planContext } from "../planning/service";
import { buildCoachProposal, type CoachEdit } from "./proposals";
import { metricLine, runLine, weekLine, weeklyTotals, workoutLine } from "./format";
import { loadActivePlan, loadMetricHistory, loadPlanWorkouts, loadRuns, toWorkoutRow } from "./data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolContext {
  db: SupabaseClient;
  userId: string;
  today: string;
  conversationId: string;
  /** proposals created during this turn, for the UI */
  proposals: string[];
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const METRICS = ["vdot", "race_5k", "race_10k", "race_half", "race_marathon", "threshold_pace", "threshold_hr", "max_hr", "rest_hr", "ctl", "atl", "tsb", "ef_trend_30d_pct"] as const;

const schemas = {
  get_runs: z.object({ from: DATE, to: DATE }),
  get_run_detail: z.object({ activity_id: z.string().uuid() }),
  get_metric_history: z.object({ metric: z.enum(METRICS), from: DATE.nullable() }),
  get_weekly_volume: z.object({ weeks: z.number().int().min(1).max(104) }),
  get_plan_workouts: z.object({ from: DATE, to: DATE }),
  get_wellness: z.object({ from: DATE, to: DATE }),
  propose_plan_change: z.object({
    title: z.string().min(3).max(120),
    explanation: z.string().min(10).max(1200),
    evidence: z.array(z.string().max(300)).max(8),
    changes: z
      .array(
        z.object({
          workout_id: z.string().uuid(),
          action: z.enum(["replace", "move"]),
          replace_with: z.enum(["easy", "recovery", "rest"]).nullable(),
          minutes: z.number().int().nullable(),
          to_date: DATE.nullable(),
        }),
      )
      .min(1)
      .max(7),
  }),
};

export type ToolName = keyof typeof schemas;

const str = (description: string) => ({ type: "string", description });
const date = (description: string) => ({ type: "string", description: `${description} (YYYY-MM-DD)` });

/** Tool definitions sent to Claude. Kept in a fixed order so the prompt cache stays valid. */
export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_runs",
    description:
      "List the athlete's imported runs between two dates (inclusive), newest first, up to 400. Each line has distance, moving time, pace, heart rate, the fitness model's run classification, efficiency factor, HR decoupling, training load, RPE and data-quality flags. Use it to look further back than the snapshot, or to find runs to compare.",
    strict: true,
    input_schema: { type: "object", properties: { from: date("first day"), to: date("last day") }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "get_run_detail",
    description:
      "Details of one run: laps and per-km splits (pace, HR, cadence, elevation), the planned workout it was matched to and how execution compared with the targets, heart-rate decoupling, best efforts within the run, data-quality flags and the athlete's feedback. Use it before commenting on a specific session.",
    strict: true,
    input_schema: { type: "object", properties: { activity_id: str("Run id from the snapshot or get_runs") }, required: ["activity_id"], additionalProperties: false },
  },
  {
    name: "get_metric_history",
    description:
      "History of one fitness-model metric. Retrospective rows are weekly values recomputed by the current model using only data up to that date (best for trends); live rows are what the model said on that day. Metrics: vdot, race_5k/race_10k/race_half/race_marathon (predicted seconds), threshold_pace (s/km), threshold_hr, max_hr, rest_hr, ctl (fitness), atl (fatigue), tsb (form), ef_trend_30d_pct (aerobic-efficiency trend).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { metric: { type: "string", enum: [...METRICS] }, from: { type: ["string", "null"], description: "First date (YYYY-MM-DD), or null for the last 12 months" } },
      required: ["metric", "from"],
      additionalProperties: false,
    },
  },
  {
    name: "get_weekly_volume",
    description: "Weekly running totals (km, minutes, number of runs, longest run) for the last N weeks, Monday-based, oldest first.",
    strict: true,
    input_schema: { type: "object", properties: { weeks: { type: "integer", description: "1 to 104" } }, required: ["weeks"], additionalProperties: false },
  },
  {
    name: "get_plan_workouts",
    description: "Workouts in the active training plan between two dates, with ids, structure (steps and pace targets), status (planned, completed, missed, skipped) and execution versus target for completed ones.",
    strict: true,
    input_schema: { type: "object", properties: { from: date("first day"), to: date("last day") }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "get_wellness",
    description: "Daily wellness data synced from Garmin between two dates (resting HR, HRV, sleep, stress, Body Battery), when available. Supplementary signals only.",
    strict: true,
    input_schema: { type: "object", properties: { from: date("first day"), to: date("last day") }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "propose_plan_change",
    description:
      "Propose a change to upcoming workouts in the active plan. Nothing changes until the athlete taps Accept on the card this creates; they can also keep the plan or undo later. Only two actions exist: replace a workout with an easy run, recovery run or rest (minutes may shorten it, never lengthen it), or move a workout to another day within 7 days. The workout content is built by the planner, not by you. The app validates every change (not in the past, not locked, not completed, not the race) and adds schedule warnings, such as two hard days in a row, to the card. Use it when the athlete asks to adapt the plan, or when the data clearly calls for it and the athlete agrees.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        title: str("Short title for the card, e.g. 'Easy Thursday after a rough week'"),
        explanation: str("Two or three sentences: what changes, why, and what it means for the goal"),
        evidence: { type: "array", items: { type: "string" }, description: "The observations behind it, one per item, with dates and numbers" },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              workout_id: str("Workout id from the plan"),
              action: { type: "string", enum: ["replace", "move"] },
              replace_with: { type: ["string", "null"], enum: ["easy", "recovery", "rest", null], description: "For replace; null for move" },
              minutes: { type: ["integer", "null"], description: "For replace with easy/recovery: length in minutes (null = the planner's default)" },
              to_date: { type: ["string", "null"], description: "For move: the new date (YYYY-MM-DD); null for replace" },
            },
            required: ["workout_id", "action", "replace_with", "minutes", "to_date"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "explanation", "evidence", "changes"],
      additionalProperties: false,
    },
  },
];

/** Short status shown in the chat while a tool runs. */
export const TOOL_STATUS: Record<ToolName, string> = {
  get_runs: "Looking through your runs",
  get_run_detail: "Reading the run in detail",
  get_metric_history: "Checking how your estimates have moved",
  get_weekly_volume: "Adding up your weekly volume",
  get_plan_workouts: "Reading your plan",
  get_wellness: "Checking recovery data",
  propose_plan_change: "Checking the change against your plan",
};

export const isToolName = (n: string): n is ToolName => n in schemas;

/** Validates and runs one tool call. Returns text for the tool_result; throws ToolInputError for bad input. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<string> {
  if (!isToolName(name)) throw new ToolInputError(`Unknown tool ${name}`);
  const parsed = schemas[name].safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input: any = parsed.data;
  switch (name) {
    case "get_runs": {
      const { from, to } = orderRange(input.from, input.to, 800);
      const runs = await loadRuns(ctx.db, ctx.userId, from, to);
      if (!runs.length) return `No runs between ${from} and ${to}.`;
      return [`${runs.length} run(s) between ${from} and ${to}:`, ...runs.map(runLine)].join("\n");
    }
    case "get_run_detail":
      return runDetail(ctx, input.activity_id);
    case "get_metric_history": {
      const { data: state } = await ctx.db.from("fitness_state").select("model_version").eq("user_id", ctx.userId).maybeSingle();
      const from = input.from ?? addDaysIso(ctx.today, -365);
      const h = await loadMetricHistory(ctx.db, ctx.userId, [input.metric], state?.model_version ?? null, from);
      const pts = h[input.metric] ?? [];
      if (!pts.length) return `No history for ${input.metric} since ${from}.`;
      return [`${input.metric} since ${from} (model ${state?.model_version}):`, ...pts.map((p) => metricLine(input.metric, p))].join("\n");
    }
    case "get_weekly_volume": {
      const runs = await loadRuns(ctx.db, ctx.userId, addDaysIso(ctx.today, -7 * input.weeks - 7), ctx.today, 2000);
      return weeklyTotals(runs, ctx.today, input.weeks)
        .map((w) => weekLine(w, ctx.today))
        .join("\n");
    }
    case "get_plan_workouts": {
      const plan = await loadActivePlan(ctx.db, ctx.userId);
      if (!plan) return "There is no active plan.";
      const { from, to } = orderRange(input.from, input.to, 200);
      const ws = await loadPlanWorkouts(ctx.db, plan.id, from, to);
      if (!ws.length) return `No planned workouts between ${from} and ${to}.`;
      return ws.map((w) => workoutLine(toWorkoutRow(w), true)).join("\n");
    }
    case "get_wellness": {
      const { from, to } = orderRange(input.from, input.to, 120);
      const { data } = await ctx.db
        .from("wellness_daily")
        .select("calendar_date, metric, value, unit")
        .eq("user_id", ctx.userId)
        .gte("calendar_date", from)
        .lte("calendar_date", to)
        .order("calendar_date")
        .order("metric");
      if (!data?.length) return `No wellness data between ${from} and ${to}.`;
      return data.map((w: any) => `${w.calendar_date} ${w.metric}: ${w.metric === "sleep_seconds" ? formatDuration(w.value) : w.value}${w.unit && w.metric !== "sleep_seconds" ? ` ${w.unit}` : ""}`).join("\n");
    }
    case "propose_plan_change":
      return proposeChange(ctx, input);
  }
}

export class ToolInputError extends Error {}

function orderRange(a: string, b: string, maxDays: number) {
  const to = a <= b ? b : a;
  const from = a <= b ? a : b;
  return { from: daysBetween(from, to) > maxDays ? addDaysIso(to, -maxDays) : from, to };
}

async function runDetail(ctx: ToolContext, id: string): Promise<string> {
  const { db, userId } = ctx;
  const [runs, { data: laps }, { data: splits }, { data: feats }, { data: planned }, { data: score }] = await Promise.all([
    db.from("activities").select("local_date").eq("id", id).eq("user_id", userId).maybeSingle(),
    db.from("activity_laps").select("lap_index, timer_s, distance_m, avg_speed, avg_hr, max_hr, avg_cadence, total_ascent_m, intensity").eq("activity_id", id).eq("user_id", userId).order("lap_index"),
    db.from("activity_splits").select("split_index, distance_m, moving_s, pace_s_per_km, avg_hr, avg_cadence, elevation_gain_m, partial").eq("activity_id", id).eq("user_id", userId).eq("split_length_m", 1000).order("split_index"),
    db.from("activity_features").select("features").eq("activity_id", id).eq("user_id", userId).maybeSingle(),
    db.from("planned_workouts").select("*").eq("activity_id", id).eq("user_id", userId).maybeSingle(),
    db.from("activity_scores").select("classification_reasons, zone_seconds, vo2max_from_hr, intensity").eq("activity_id", id).eq("user_id", userId).maybeSingle(),
  ]);
  if (!runs.data) return `No run with id ${id}.`;
  const [row] = await loadRuns(db, userId, runs.data.local_date, runs.data.local_date).then((rs) => rs.filter((r) => r.id === id));
  const L: string[] = [row ? runLine(row) : `Run ${id}`];
  if (score) {
    if (score.classification_reasons?.length) L.push(`Why it was classified that way: ${score.classification_reasons.join("; ")}`);
    if (score.intensity != null) L.push(`Intensity: ${Math.round(score.intensity * 100)} % of HR reserve over the steady part.`);
    if (score.zone_seconds?.length) L.push(`Time in HR zones 1–5: ${score.zone_seconds.map((s: number) => formatDuration(s)).join(" / ")}`);
  }
  const f = feats?.features;
  if (f) {
    if (f.halves) L.push(`Steady-part halves: first ${f.halves[0].avgHr ? `HR ${Math.round(f.halves[0].avgHr)}` : ""} ${f.halves[0].distanceM && f.halves[0].movingS ? `${formatPace(f.halves[0].movingS / (f.halves[0].distanceM / 1000))}/km` : ""}; second ${f.halves[1].avgHr ? `HR ${Math.round(f.halves[1].avgHr)}` : ""} ${f.halves[1].distanceM && f.halves[1].movingS ? `${formatPace(f.halves[1].movingS / (f.halves[1].distanceM / 1000))}/km` : ""}`.replace(/\s+/g, " "));
    if (f.speedCv != null) L.push(`Pace variability (CV of 60-s speed): ${(f.speedCv * 100).toFixed(0)} %; fast bouts: ${f.fastBouts}.`);
    if (f.bestEfforts?.length) L.push(`Best efforts in this run: ${f.bestEfforts.map((b: any) => `${b.distanceM} m ${formatDuration(b.timeS)}${b.avgHr ? ` @ HR ${Math.round(b.avgHr)}` : ""}`).join("; ")}`);
  }
  if (laps?.length) {
    L.push("Laps:");
    for (const l of laps) L.push(`  ${l.lap_index + 1}: ${((l.distance_m ?? 0) / 1000).toFixed(2)} km in ${formatDuration(l.timer_s)}, ${l.avg_speed ? `${formatPace(1000 / l.avg_speed)}/km` : "–"}, HR ${l.avg_hr ? Math.round(l.avg_hr) : "–"}/${l.max_hr ? Math.round(l.max_hr) : "–"}${l.avg_cadence ? `, cadence ${Math.round(l.avg_cadence)}` : ""}${l.intensity ? ` (${l.intensity})` : ""}`);
  }
  if (splits?.length) {
    L.push("Per-km splits:");
    for (const s of splits) L.push(`  km ${s.split_index + 1}${s.partial ? ` (partial ${(s.distance_m / 1000).toFixed(2)} km)` : ""}: ${formatPace(s.pace_s_per_km)}/km, HR ${s.avg_hr ? Math.round(s.avg_hr) : "–"}${s.elevation_gain_m ? `, +${Math.round(s.elevation_gain_m)} m` : ""}`);
  }
  if (planned) {
    L.push(`Matched planned workout: ${workoutLine(toWorkoutRow(planned), true)}`);
    for (const n of planned.execution?.notes ?? []) L.push(`  execution note: ${n}`);
  } else L.push("Not matched to a planned workout.");
  return L.join("\n");
}

async function proposeChange(ctx: ToolContext, input: z.infer<(typeof schemas)["propose_plan_change"]>): Promise<string> {
  const plan = await loadActivePlan(ctx.db, ctx.userId);
  if (!plan) return "Not created: there is no active plan. Suggest creating one on the Plan tab.";
  const ids = input.changes.map((c) => c.workout_id);
  const { data: rows } = await ctx.db.from("planned_workouts").select("*").eq("plan_id", plan.id).gte("date", addDaysIso(ctx.today, -7)).lte("date", addDaysIso(ctx.today, 21)).order("date");
  const { data: last } = await ctx.db.from("planned_workouts").select("date").eq("plan_id", plan.id).order("date", { ascending: false }).limit(1).maybeSingle();
  const edits: CoachEdit[] = [];
  const errors: string[] = [];
  for (const c of input.changes) {
    if (c.action === "replace") {
      if (!c.replace_with) errors.push(`${c.workout_id}: replace needs replace_with.`);
      else edits.push({ workoutId: c.workout_id, action: "replace", with: c.replace_with, minutes: c.minutes });
    } else if (!c.to_date) errors.push(`${c.workout_id}: move needs to_date.`);
    else edits.push({ workoutId: c.workout_id, action: "move", toDate: c.to_date });
  }
  if (errors.length) return `Not created:\n${errors.join("\n")}`;
  const known = new Set((rows ?? []).map((r: any) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) return `Not created: these workouts are not in the active plan within the next three weeks: ${missing.join(", ")}.`;
  const result = buildCoachProposal({
    today: ctx.today,
    title: input.title,
    explanation: input.explanation,
    evidence: input.evidence,
    edits,
    workouts: (rows ?? []).map((w: any) => ({
      id: w.id,
      date: w.date,
      type: w.type,
      title: w.title,
      objective: w.objective,
      why: w.why,
      steps: w.steps,
      durationS: w.duration_s,
      distanceM: w.distance_m,
      locked: w.locked,
      status: w.status,
    })),
    ctx: planContext(plan),
    unavailableDays: plan.config?.unavailableDays ?? [],
    planEnd: last?.date ?? addDaysIso(ctx.today, 21),
  });
  if (!result.ok) return `Not created. Fix these and try again, or explain to the athlete why it can't be done:\n${result.errors.join("\n")}`;
  const { data, error } = await ctx.db
    .from("adaptation_proposals")
    .insert({
      plan_id: plan.id,
      user_id: ctx.userId,
      rule: "coach",
      key: `coach:${randomUUID()}`,
      title: result.title,
      explanation: result.explanation,
      evidence: result.evidence,
      changes: result.changes,
      conversation_id: ctx.conversationId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  ctx.proposals.push(data.id);
  return [
    `Proposal created (id ${data.id}). A card with Accept and "Keep my plan" buttons is now shown under your reply; nothing changes until the athlete accepts. Don't ask them to confirm in text, just point to the card.`,
    ...result.changes.map((c) => `- ${c.date}: ${c.before.title} → ${c.toDate ? `moved to ${c.toDate}` : c.after.title}`),
    ...(result.warnings.length ? ["Schedule warnings shown on the card (mention them):", ...result.warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
}
