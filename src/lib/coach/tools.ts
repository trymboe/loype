import "server-only";
import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { addDaysIso, daysBetween, formatDay } from "../dates";
import { formatDuration, formatPace } from "../units";
import { fmtTime } from "../analytics/fitness/estimate";
import { recomputeFitness } from "../fitness/service";
import { checkStepEdit, decideProposal, editWorkout, frequencyLabel, loadIssues, planContext, restoreVersion, snapshot, updateGoal, type GoalEdit } from "../planning/service";
import { editableSteps } from "../planning/edit-steps";
import { moveIssues, validateSchedule } from "../planning/validate";
import { buildWorkout, stepsDistance, stepsDuration } from "../planning/workouts";
import { HARD_TYPES, WORKOUT_LABEL, type WorkoutType } from "../planning/types";
import type { PlanConfig } from "../planning/types";
import { routeFromActivity } from "../routes/from-activity";
import { metricLine, routeLine, runLine, weekLine, weeklyTotals, workoutLine } from "./format";
import { loadActivePlan, loadMetricHistory, loadPlanWorkouts, loadRoutes, loadRuns, toWorkoutRow } from "./data";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Something the coach changed, recorded on the message so the chat can show it and undo plan changes. */
export interface CoachAction {
  kind: "plan" | "route" | "run";
  summary: string;
  planId?: string;
  /** the plan version before this change: undo restores it */
  versionBefore?: number;
  /** settings and goal before a settings change (versions only hold workouts) */
  prevConfig?: PlanConfig;
  prevGoal?: { name: string | null; target_time_s: number | null; target_weekly_km: number | null };
}

export interface ToolContext {
  db: SupabaseClient;
  userId: string;
  today: string;
  /** changes made during this tool round */
  actions: CoachAction[];
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const ID = z.string().uuid();
const METRICS = ["vdot", "race_5k", "race_10k", "race_half", "race_marathon", "threshold_pace", "threshold_hr", "max_hr", "rest_hr", "ctl", "atl", "tsb", "ef_trend_30d_pct"] as const;
const ZONES = ["recovery", "easy", "steady", "marathon", "threshold", "interval", "repetition", "race", "hill"] as const;
/** Session types the coach can schedule (the race itself is fixed by the goal). */
const SESSION_TYPES = ["easy", "recovery", "long", "progressive_long", "threshold", "tempo", "vo2max", "repetitions", "hills", "race_pace", "strides", "rest"] as const;
const CLASSES = ["recovery", "easy", "long", "steady", "threshold", "intervals", "race"] as const;

const simpleStep = z.object({
  kind: z.enum(["warmup", "cooldown", "run", "recover"]),
  minutes: z.number().nullable(),
  distance_m: z.number().nullable(),
  zone: z.enum(ZONES),
  note: z.string().nullable(),
});
const anyStep = z.object({
  kind: z.enum(["warmup", "cooldown", "run", "recover", "repeat"]),
  minutes: z.number().nullable(),
  distance_m: z.number().nullable(),
  zone: z.enum(ZONES).nullable(),
  note: z.string().nullable(),
  count: z.number().int().nullable(),
  steps: z.array(simpleStep).nullable(),
});

const schemas = {
  get_runs: z.object({ from: DATE, to: DATE }),
  get_run_detail: z.object({ activity_id: ID }),
  get_metric_history: z.object({ metric: z.enum(METRICS), from: DATE.nullable() }),
  get_weekly_volume: z.object({ weeks: z.number().int().min(1).max(104) }),
  get_plan_workouts: z.object({ from: DATE, to: DATE }),
  get_plan_history: z.object({ limit: z.number().int().min(1).max(50) }),
  get_wellness: z.object({ from: DATE, to: DATE }),
  get_routes: z.object({}),
  edit_workout: z.object({
    workout_id: ID,
    action: z.enum(["move", "skip", "restore", "easy", "rest", "lock", "unlock"]),
    date: DATE.nullable(),
    confirmed: z.boolean(),
  }),
  replace_workout: z.object({ workout_id: ID, type: z.enum(SESSION_TYPES), minutes: z.number().min(10).max(300).nullable(), intensity: z.number().min(0).max(1).nullable(), confirmed: z.boolean() }),
  add_workout: z.object({ date: DATE, type: z.enum(SESSION_TYPES), minutes: z.number().min(10).max(300).nullable(), intensity: z.number().min(0).max(1).nullable(), confirmed: z.boolean() }),
  set_workout_steps: z.object({ workout_id: ID, steps: z.array(anyStep).min(1).max(20), confirmed: z.boolean() }),
  change_plan_settings: z.object({
    run_days: z.array(z.number().int().min(0).max(6)).nullable(),
    runs_per_week: z.number().int().min(0).max(7).nullable(),
    long_run_day: z.number().int().min(-1).max(6).nullable(),
    max_weekly_hours: z.number().min(0).max(20).nullable(),
    include_intervals: z.boolean().nullable(),
    include_long_runs: z.boolean().nullable(),
    include_strides: z.boolean().nullable(),
    target_time: z.string().nullable(),
    target_weekly_km: z.number().min(0).max(200).nullable(),
    race_name: z.string().max(80).nullable(),
    confirmed: z.boolean(),
  }),
  restore_plan_version: z.object({ version: z.number().int().min(1) }),
  respond_to_proposal: z.object({ proposal_id: ID, accept: z.boolean() }),
  update_route: z.object({ route_id: ID, name: z.string().max(80).nullable(), favorite: z.boolean().nullable() }),
  link_route_to_workout: z.object({ route_id: ID, workout_id: ID, link: z.boolean() }),
  save_run_as_route: z.object({ activity_id: ID }),
  delete_route: z.object({ route_id: ID, confirmed: z.boolean() }),
  save_run_feedback: z.object({
    activity_id: ID,
    rpe: z.number().int().min(1).max(10),
    legs: z.enum(["fresh", "normal", "heavy", "sore"]).nullable(),
    notes: z.string().max(2000).nullable(),
  }),
  set_run_type: z.object({ activity_id: ID, classification: z.enum(CLASSES).nullable() }),
};

export type ToolName = keyof typeof schemas;

// ---------- JSON schemas sent to the model (strict: every property required, null for "not given") ----------

const s = (description: string) => ({ type: "string", description });
const ns = (description: string) => ({ type: ["string", "null"], description });
const date = (description: string) => ({ type: "string", description: `${description} (YYYY-MM-DD)` });
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const CONFIRMED = { type: "boolean", description: "false on the first try. true only after the app returned warnings and the athlete agreed to go ahead anyway." };
const simpleStepSchema = obj({
  kind: { type: "string", enum: ["warmup", "cooldown", "run", "recover"] },
  minutes: { type: ["number", "null"], description: "Duration in minutes, or null when distance is given" },
  distance_m: { type: ["number", "null"], description: "Distance in metres, or null when minutes is given" },
  zone: { type: "string", enum: [...ZONES] },
  note: ns("Short cue shown on the watch, or null"),
});

const fn = (name: ToolName, description: string, parameters: Record<string, unknown>): OpenAI.Responses.FunctionTool => ({ type: "function", name, description, parameters, strict: true });

/** Tool definitions, in a fixed order so the prompt prefix stays cacheable. */
export const TOOLS: OpenAI.Responses.FunctionTool[] = [
  fn("get_runs", "List the athlete's runs between two dates (inclusive), newest first, up to 400: distance, time, pace, HR, run type, efficiency, decoupling, load, RPE and data-quality flags.", obj({ from: date("first day"), to: date("last day") })),
  fn("get_run_detail", "One run in detail: laps, per-km splits, HR zones, the planned workout it matched and how it went against the targets, best efforts, feedback.", obj({ activity_id: s("Run id") })),
  fn(
    "get_metric_history",
    "History of one fitness-model metric. 'retro' rows are weekly values recomputed with data up to that date (best for trends); 'live' rows are what the model said that day. race_* are predicted seconds, threshold_pace is s/km, ctl/atl/tsb are fitness/fatigue/form.",
    obj({ metric: { type: "string", enum: [...METRICS] }, from: ns("First date (YYYY-MM-DD), or null for the last 12 months") }),
  ),
  fn("get_weekly_volume", "Weekly running totals (km, minutes, runs, longest run) for the last N Monday-based weeks, oldest first. Use it before any increase in training.", obj({ weeks: { type: "integer", description: "1 to 104" } })),
  fn("get_plan_workouts", "Workouts in the active plan between two dates, with ids, steps, pace targets, status and execution.", obj({ from: date("first day"), to: date("last day") })),
  fn("get_plan_history", "Recent versions of the plan (newest first) with what changed in each. Use with restore_plan_version.", obj({ limit: { type: "integer", description: "1 to 50" } })),
  fn("get_wellness", "Daily Garmin wellness between two dates (resting HR, HRV, sleep, stress, Body Battery), when synced.", obj({ from: date("first day"), to: date("last day") })),
  fn("get_routes", "All saved routes with distance, estimated climb, favourite flag and the workouts they're linked to.", obj({})),
  fn(
    "edit_workout",
    "Change one planned workout, exactly like the buttons on the workout page. move: to another date (not in the past, at most 14 days away; the app checks the schedule). skip: mark it skipped (removes it from the week). restore: un-skip it. easy / rest: replace it with an easy run (shorter) or rest; the planner builds it. lock / unlock: protect it from automatic changes. Completed workouts can't be changed.",
    obj({ workout_id: s("Workout id"), action: { type: "string", enum: ["move", "skip", "restore", "easy", "rest", "lock", "unlock"] }, date: ns("New date for move (YYYY-MM-DD), otherwise null"), confirmed: CONFIRMED }),
  ),
  fn(
    "replace_workout",
    "Turn a planned workout into a different session, e.g. intervals into a long run, an easy run into a tempo run, or anything into rest. The planner builds the session from the athlete's paces and zones. minutes sets the length of easy, recovery, long and progressive long runs (null = the planner's default); structured sessions (threshold, tempo, vo2max, repetitions, hills, race_pace) get their standard structure, scaled by intensity from 0 (gentlest) to 1 (hardest of its phase), null = 0.5. Use set_workout_steps afterwards for a custom structure. The app checks the change against the planner's safety rules and returns warnings unless confirmed.",
    obj({ workout_id: s("Workout id"), type: { type: "string", enum: [...SESSION_TYPES] }, minutes: { type: ["number", "null"], description: "Minutes, or null" }, intensity: { type: ["number", "null"], description: "0-1 for structured sessions, or null" }, confirmed: CONFIRMED }),
  ),
  fn(
    "add_workout",
    "Add a new session to the plan on a day (today or later, within the plan). Same session types and options as replace_workout. The app checks the schedule (hard days back to back, two sessions on one day) and the load rules and returns warnings unless confirmed. To raise weekly training time, add sessions or lengthen existing ones; check recent weekly volume first.",
    obj({ date: date("Day"), type: { type: "string", enum: [...SESSION_TYPES] }, minutes: { type: ["number", "null"], description: "Minutes, or null" }, intensity: { type: ["number", "null"], description: "0-1 for structured sessions, or null" }, confirmed: CONFIRMED }),
  ),
  fn(
    "set_workout_steps",
    "Rewrite the structure of a planned workout (to shorten, lengthen, or change its intervals). The app rebuilds pace and HR targets from the athlete's zones and checks the result against the planner's safety rules (long-run jumps, weekly load, hard minutes). Each step has minutes or distance_m. A repeat block has count and steps (its inner steps); other steps leave count and steps null.",
    obj({
      workout_id: s("Workout id"),
      steps: {
        type: "array",
        items: obj({
          kind: { type: "string", enum: ["warmup", "cooldown", "run", "recover", "repeat"] },
          minutes: { type: ["number", "null"], description: "Minutes, or null" },
          distance_m: { type: ["number", "null"], description: "Metres, or null" },
          zone: { type: ["string", "null"], enum: [...ZONES, null], description: "Intensity zone; null only for repeat" },
          note: ns("Short cue, or null"),
          count: { type: ["integer", "null"], description: "Repetitions for repeat, otherwise null" },
          steps: { type: ["array", "null"], items: simpleStepSchema, description: "Inner steps for repeat, otherwise null" },
        }),
      },
      confirmed: CONFIRMED,
    }),
  ),
  fn(
    "change_plan_settings",
    "Change the plan's goal details and training settings, like the Edit goal form. Any field left null stays as it is. Changing the training settings recalculates the rest of the plan from this week on (finished, locked and hand-edited workouts are kept). The app checks increases against recent load and returns warnings instead of applying them unless confirmed.",
    obj({
      run_days: { type: ["array", "null"], items: { type: "integer" }, description: "Days available to run, 0 = Monday … 6 = Sunday (at least 2), or null" },
      runs_per_week: { type: ["integer", "null"], description: "Runs per week (1-7), 0 to let the planner choose from history, or null" },
      long_run_day: { type: ["integer", "null"], description: "0-6, -1 for no fixed day, or null" },
      max_weekly_hours: { type: ["number", "null"], description: "Weekly time cap in hours (1-20), 0 to remove the cap, or null" },
      include_intervals: { type: ["boolean", "null"] },
      include_long_runs: { type: ["boolean", "null"] },
      include_strides: { type: ["boolean", "null"] },
      target_time: ns("Race target as h:mm:ss or mm:ss (race goals only), 'none' to remove it, or null"),
      target_weekly_km: { type: ["number", "null"], description: "Weekly km target (volume goals only), 0 to remove, or null" },
      race_name: ns("Race name (custom race goals only), or null"),
      confirmed: CONFIRMED,
    }),
  ),
  fn("restore_plan_version", "Put every not-yet-done workout back to how it was in an earlier plan version (from get_plan_history).", obj({ version: { type: "integer" } })),
  fn("respond_to_proposal", "Accept a pending plan-change proposal (from the app's adaptation rules), or keep the plan as it is.", obj({ proposal_id: s("Proposal id"), accept: { type: "boolean" } })),
  fn("update_route", "Rename a saved route and/or mark it as a favourite. Null leaves a field unchanged.", obj({ route_id: s("Route id"), name: ns("New name, or null"), favorite: { type: ["boolean", "null"] } })),
  fn("link_route_to_workout", "Attach a saved route to a planned workout (shown on the workout), or detach it.", obj({ route_id: s("Route id"), workout_id: s("Workout id"), link: { type: "boolean" } })),
  fn("save_run_as_route", "Save the GPS track of a recorded run as a route.", obj({ activity_id: s("Run id") })),
  fn("delete_route", "Delete a saved route permanently. Only when the athlete explicitly asked to delete it; this can't be undone.", obj({ route_id: s("Route id"), confirmed: { type: "boolean", description: "true: the athlete explicitly asked to delete this route" } })),
  fn(
    "save_run_feedback",
    "Record the athlete's check-in for a run: RPE 1-10, how the legs felt, notes (e.g. pain, conditions). Use when they tell you how a run felt.",
    obj({ activity_id: s("Run id"), rpe: { type: "integer", description: "1-10" }, legs: { type: ["string", "null"], enum: ["fresh", "normal", "heavy", "sore", null] }, notes: ns("Notes, or null") }),
  ),
  fn("set_run_type", "Correct the type of a run (the fitness model then recalculates), or null to go back to the automatic type.", obj({ activity_id: s("Run id"), classification: { type: ["string", "null"], enum: [...CLASSES, null] } })),
];

/** Short status shown in the chat while a tool runs. */
export const TOOL_STATUS: Record<ToolName, string> = {
  get_runs: "Looking through your runs",
  get_run_detail: "Reading the run in detail",
  get_metric_history: "Checking how your estimates have moved",
  get_weekly_volume: "Adding up your weekly volume",
  get_plan_workouts: "Reading your plan",
  get_plan_history: "Checking the plan history",
  get_wellness: "Checking recovery data",
  get_routes: "Looking at your routes",
  edit_workout: "Updating your plan",
  replace_workout: "Rebuilding the session",
  add_workout: "Adding the session",
  set_workout_steps: "Updating the workout",
  change_plan_settings: "Updating your plan settings",
  restore_plan_version: "Restoring your plan",
  respond_to_proposal: "Updating your plan",
  update_route: "Updating the route",
  link_route_to_workout: "Linking the route",
  save_run_as_route: "Saving the route",
  delete_route: "Deleting the route",
  save_run_feedback: "Saving your check-in",
  set_run_type: "Updating the run",
};

export const isToolName = (n: string): n is ToolName => n in schemas;

/** Validates and runs one tool call. Returns text for the model; throws ToolInputError for bad input. */
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
    case "get_plan_history": {
      const plan = await loadActivePlan(ctx.db, ctx.userId);
      if (!plan) return "There is no active plan.";
      const { data } = await ctx.db.from("plan_versions").select("version, reason, created_by, created_at").eq("plan_id", plan.id).order("version", { ascending: false }).limit(input.limit);
      if (!data?.length) return "No versions yet.";
      return [`Current version: ${plan.current_version}.`, ...data.map((v: any) => `v${v.version} ${v.created_at.slice(0, 16).replace("T", " ")} UTC by ${v.created_by}: ${v.reason}`)].join("\n");
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
    case "get_routes": {
      const routes = await loadRoutes(ctx.db, ctx.userId, 200);
      return routes.length ? routes.map(routeLine).join("\n") : "No saved routes. New routes are drawn on the Routes tab.";
    }
    case "edit_workout":
      return editWorkoutTool(ctx, input);
    case "set_workout_steps":
      return setStepsTool(ctx, input);
    case "replace_workout":
      return replaceTool(ctx, input);
    case "add_workout":
      return addTool(ctx, input);
    case "change_plan_settings":
      return settingsTool(ctx, input);
    case "restore_plan_version": {
      const plan = await loadActivePlan(ctx.db, ctx.userId);
      if (!plan) return "There is no active plan.";
      const { data: v } = await ctx.db.from("plan_versions").select("version").eq("plan_id", plan.id).eq("version", input.version).maybeSingle();
      if (!v) return `There is no version ${input.version}.`;
      await restoreVersion(ctx.db, ctx.userId, plan.id, input.version);
      ctx.actions.push({ kind: "plan", summary: `Restored the plan to version ${input.version}`, planId: plan.id, versionBefore: plan.current_version });
      return `Done: every not-yet-done workout is back to how it was in version ${input.version}.`;
    }
    case "respond_to_proposal": {
      const { data: p } = await ctx.db.from("adaptation_proposals").select("id, plan_id, title, status").eq("id", input.proposal_id).eq("user_id", ctx.userId).maybeSingle();
      if (!p) return "No such proposal.";
      if (p.status !== "pending") return `That proposal is already ${p.status}.`;
      const { data: plan } = await ctx.db.from("training_plans").select("current_version").eq("id", p.plan_id).single();
      await decideProposal(ctx.db, ctx.userId, p.id, input.accept);
      if (input.accept) ctx.actions.push({ kind: "plan", summary: `Accepted: ${p.title}`, planId: p.plan_id, versionBefore: plan?.current_version ?? undefined });
      return input.accept ? `Accepted "${p.title}"; the plan is updated.` : `Kept the plan; "${p.title}" was declined.`;
    }
    case "update_route": {
      const patch: Record<string, unknown> = {};
      if (input.name?.trim()) patch.name = input.name.trim().slice(0, 80);
      if (input.favorite != null) patch.favorite = input.favorite;
      if (!Object.keys(patch).length) return "Nothing to change.";
      const { data } = await ctx.db.from("routes").update(patch).eq("id", input.route_id).eq("user_id", ctx.userId).select("name").maybeSingle();
      if (!data) return "No such route.";
      ctx.actions.push({ kind: "route", summary: `${patch.name ? `Renamed route to "${patch.name}"` : `Updated route "${data.name}"`}${input.favorite != null ? (input.favorite ? ", marked as favourite" : ", removed from favourites") : ""}` });
      return "Done.";
    }
    case "link_route_to_workout": {
      const [{ data: r }, { data: w }] = await Promise.all([
        ctx.db.from("routes").select("name").eq("id", input.route_id).eq("user_id", ctx.userId).maybeSingle(),
        ctx.db.from("planned_workouts").select("title, date, route_id").eq("id", input.workout_id).eq("user_id", ctx.userId).maybeSingle(),
      ]);
      if (!r) return "No such route.";
      if (!w) return "No such workout.";
      if (!input.link && w.route_id !== input.route_id) return "That route isn't linked to this workout.";
      await check(ctx.db.from("planned_workouts").update({ route_id: input.link ? input.route_id : null }).eq("id", input.workout_id).eq("user_id", ctx.userId));
      ctx.actions.push({ kind: "route", summary: `${input.link ? "Linked" : "Unlinked"} route "${r.name}" ${input.link ? "to" : "from"} ${w.title} (${formatDay(w.date)})` });
      return "Done.";
    }
    case "save_run_as_route": {
      const res = await routeFromActivity(ctx.db, ctx.userId, input.activity_id);
      if ("error" in res) return `Not saved: ${res.error}.`;
      if (res.existed) return `That run is already saved as a route (route id ${res.id}).`;
      ctx.actions.push({ kind: "route", summary: "Saved a run as a route" });
      return `Saved as a route (route id ${res.id}). It shows on the Routes tab.`;
    }
    case "delete_route": {
      if (!input.confirmed) return "Not deleted. Deleting is permanent: only do it when the athlete explicitly asked to delete this route, then call again with confirmed true.";
      const { data } = await ctx.db.from("routes").delete().eq("id", input.route_id).eq("user_id", ctx.userId).select("name").maybeSingle();
      if (!data) return "No such route.";
      ctx.actions.push({ kind: "route", summary: `Deleted route "${data.name}"` });
      return "Deleted.";
    }
    case "save_run_feedback": {
      const { data: a } = await ctx.db.from("activities").select("id, local_date, name").eq("id", input.activity_id).eq("user_id", ctx.userId).maybeSingle();
      if (!a) return "No such run.";
      await check(
        ctx.db.from("workout_feedback").upsert({ activity_id: a.id, user_id: ctx.userId, rpe: input.rpe, legs: input.legs, ...(input.notes != null ? { notes: input.notes || null } : {}) }, { onConflict: "activity_id" }),
      );
      ctx.actions.push({ kind: "run", summary: `Saved your check-in for ${a.name ?? "the run"} on ${formatDay(a.local_date)} (RPE ${input.rpe})` });
      return "Saved.";
    }
    case "set_run_type": {
      const { data: a } = await ctx.db.from("activities").update({ classification_override: input.classification }).eq("id", input.activity_id).eq("user_id", ctx.userId).select("name, local_date").maybeSingle();
      if (!a) return "No such run.";
      await recomputeFitness(ctx.db, ctx.userId, ctx.today);
      ctx.actions.push({ kind: "run", summary: `Set ${a.name ?? "the run"} on ${formatDay(a.local_date)} to ${input.classification ?? "the automatic type"}` });
      return "Done; the fitness model was recalculated.";
    }
  }
}

async function check(q: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await q;
  if (error) throw new Error(error.message);
}

/** The workout, if it belongs to the athlete's active plan. */
async function ownWorkout(ctx: ToolContext, id: string): Promise<{ error: string } | { plan: any; w: any }> {
  const plan = await loadActivePlan(ctx.db, ctx.userId);
  if (!plan) return { error: "There is no active plan." };
  const { data: w } = await ctx.db.from("planned_workouts").select("*").eq("id", id).eq("plan_id", plan.id).maybeSingle();
  if (!w) return { error: "That workout isn't in the active plan." };
  return { plan, w };
}

async function editWorkoutTool(ctx: ToolContext, input: z.infer<(typeof schemas)["edit_workout"]>): Promise<string> {
  const found = await ownWorkout(ctx, input.workout_id);
  if ("error" in found) return found.error;
  const { plan, w } = found;
  const label = `${w.title} (${formatDay(w.date)})`;
  if (w.status === "completed" || w.status === "missed") return `Not changed: ${label} is ${w.status}.`;
  const a = input.action;
  if (a !== "restore" && a !== "lock" && a !== "unlock" && w.status !== "planned") return `Not changed: ${label} is ${w.status}.`;
  if (a === "restore" && w.status !== "skipped") return `${label} isn't skipped.`;
  if (w.date < ctx.today && a !== "lock" && a !== "unlock") return `Not changed: ${label} is in the past.`;
  if ((a === "easy" || a === "rest" || a === "skip" || a === "move") && w.locked) return `Not changed: the athlete locked ${label}. Unlock it first if they want it changed.`;
  if (w.type === "race" && a !== "lock" && a !== "unlock") return "The race itself can't be changed from here.";
  if (a === "move") {
    if (!input.date) return "Give the new date.";
    if (input.date < ctx.today) return "Can't move a workout into the past.";
    if (input.date === w.date) return "It's already on that day.";
    if (Math.abs(daysBetween(w.date, input.date)) > 14) return "Move it at most two weeks.";
    if (!input.confirmed) {
      const { data: all } = await ctx.db.from("planned_workouts").select("id, date, type, status").eq("plan_id", plan.id);
      const issues = moveIssues(all ?? [], w.id, input.date, plan.config?.unavailableDays ?? []);
      if (issues.length) return `Not moved yet. The schedule check found:\n${issues.map((i) => `- ${i.message}`).join("\n")}\nTell the athlete, suggest a better day if there is one, and only call again with confirmed true if they still want this day.`;
    }
  }
  const edit =
    a === "move" ? ({ kind: "move", date: input.date! } as const)
    : a === "skip" ? ({ kind: "skip" } as const)
    : a === "restore" ? ({ kind: "unskip" } as const)
    : a === "lock" || a === "unlock" ? ({ kind: "lock", locked: a === "lock" } as const)
    : ({ kind: "swap", to: a } as const);
  await editWorkout(ctx.db, ctx.userId, w.id, edit);
  const summary =
    a === "move" ? `Moved ${label} to ${formatDay(input.date!)}`
    : a === "skip" ? `Removed ${label} from the week`
    : a === "restore" ? `Put ${label} back in the plan`
    : a === "lock" ? `Locked ${label}`
    : a === "unlock" ? `Unlocked ${label}`
    : `Swapped ${label} for ${a === "rest" ? "rest" : "an easy run"}`;
  ctx.actions.push({ kind: "plan", summary, planId: plan.id, versionBefore: plan.current_version });
  if (a === "easy") {
    const { data: nw } = await ctx.db.from("planned_workouts").select("title, duration_s").eq("id", w.id).single();
    return `Done: ${summary} (${nw?.title}, ${Math.round((nw?.duration_s ?? 0) / 60)} min).`;
  }
  return `Done: ${summary}.`;
}

async function setStepsTool(ctx: ToolContext, input: z.infer<(typeof schemas)["set_workout_steps"]>): Promise<string> {
  const found = await ownWorkout(ctx, input.workout_id);
  if ("error" in found) return found.error;
  const { plan, w } = found;
  if (w.status !== "planned" || w.date < ctx.today) return `Not changed: ${w.title} is ${w.date < ctx.today ? "in the past" : w.status}.`;
  if (w.type === "rest") return "That's a rest day; swap it with edit_workout instead.";
  const simple = (x: { kind: string; minutes: number | null; distance_m: number | null; zone: string | null; note: string | null }) => ({
    kind: x.kind,
    ...(x.minutes != null ? { durationS: Math.round(x.minutes * 60) } : {}),
    ...(x.distance_m != null ? { distanceM: Math.round(x.distance_m) } : {}),
    zone: x.zone,
    ...(x.note ? { note: x.note } : {}),
  });
  const raw = input.steps.map((x) => (x.kind === "repeat" ? { kind: "repeat", count: x.count, steps: (x.steps ?? []).map(simple) } : simple(x)));
  const parsed = editableSteps.safeParse(raw);
  if (!parsed.success) return `Not changed: the steps aren't valid (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}). Every step needs a zone and minutes or distance; a repeat needs a count and 1-6 inner steps.`;
  if (!input.confirmed) {
    const issues = await checkStepEdit(ctx.db, ctx.userId, w.id, parsed.data);
    if (issues.length) return `Not changed yet. The app's safety check found:\n${issues.map((i) => `- ${i}`).join("\n")}\nExplain the risk to the athlete with their numbers and offer a safer version; only call again with confirmed true if they still want it.`;
  }
  await editWorkout(ctx.db, ctx.userId, w.id, { kind: "steps", steps: parsed.data });
  const { data: nw } = await ctx.db.from("planned_workouts").select("title, duration_s").eq("id", w.id).single();
  const summary = `Changed ${w.title} (${formatDay(w.date)}) to ${nw?.title ?? "the new structure"}, ${Math.round((nw?.duration_s ?? 0) / 60)} min`;
  ctx.actions.push({ kind: "plan", summary, planId: plan.id, versionBefore: plan.current_version });
  return `Done: ${summary}.`;
}

/** "1:50:00", "50:00" → seconds; null if unparseable. */
function parseTime(v: string): number | null {
  const parts = v.trim().split(":").map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

const RACE_KINDS = ["5k", "10k", "half", "marathon", "race"];

async function settingsTool(ctx: ToolContext, input: z.infer<(typeof schemas)["change_plan_settings"]>): Promise<string> {
  const plan = await loadActivePlan(ctx.db, ctx.userId);
  if (!plan) return "There is no active plan. The athlete can create one on the Plan tab.";
  const cfg = (plan.config ?? {}) as PlanConfig;
  const g = plan.goal;
  const config: NonNullable<GoalEdit["config"]> = {};
  const errors: string[] = [];
  if (input.run_days) {
    const days = [...new Set(input.run_days)].sort();
    if (days.length < 2) errors.push("At least 2 run days are needed.");
    config.runDays = days;
    config.unavailableDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.includes(d));
  }
  if (input.runs_per_week != null) config.runsPerWeek = input.runs_per_week === 0 ? null : input.runs_per_week;
  const runDays = config.runDays ?? cfg.runDays ?? [];
  const rpw = config.runsPerWeek !== undefined ? config.runsPerWeek : cfg.runsPerWeek;
  if (rpw && rpw > runDays.length) errors.push(`${rpw} runs a week needs at least ${rpw} run days (currently ${runDays.length}).`);
  if (input.long_run_day != null) config.longRunDay = input.long_run_day < 0 ? null : input.long_run_day;
  if (input.max_weekly_hours != null) {
    if (input.max_weekly_hours !== 0 && input.max_weekly_hours < 1) errors.push("The weekly cap should be at least 1 hour (or 0 to remove it).");
    config.maxWeeklyMinutes = input.max_weekly_hours === 0 ? null : Math.round(input.max_weekly_hours * 60);
  }
  if (input.include_intervals != null) config.includeIntervals = input.include_intervals;
  if (input.include_long_runs != null) config.includeLongRuns = input.include_long_runs;
  if (input.include_strides != null) config.includeStrides = input.include_strides;
  const edit: GoalEdit = { config };
  if (input.target_time != null) {
    if (!RACE_KINDS.includes(g.kind)) errors.push("A target time only applies to race goals.");
    else if (input.target_time.trim().toLowerCase() === "none") edit.targetTimeS = null;
    else {
      const t = parseTime(input.target_time);
      if (t == null || t < 600) errors.push("Write the target time as h:mm:ss or mm:ss.");
      else edit.targetTimeS = t;
    }
  }
  if (input.target_weekly_km != null) {
    if (g.kind !== "volume") errors.push("A weekly km target only applies to volume goals.");
    else edit.targetWeeklyKm = input.target_weekly_km === 0 ? null : input.target_weekly_km;
  }
  if (input.race_name != null) {
    if (g.kind !== "race") errors.push("Only custom race goals have a name.");
    else edit.name = input.race_name.trim() || null;
  }
  if (errors.length) return `Not changed:\n${errors.map((e) => `- ${e}`).join("\n")}`;

  if (!input.confirmed) {
    const risks = await settingsRisks(ctx, cfg, g, config, edit);
    if (risks.length) return `Not changed yet. Compared with the athlete's recent training:\n${risks.map((r) => `- ${r}`).join("\n")}\nExplain this to the athlete and offer a safer step; only call again with confirmed true if they still want it.`;
  }
  const versionBefore = plan.current_version;
  const changes = await updateGoal(ctx.db, ctx.userId, edit, { today: ctx.today });
  if (!changes.length) return "Nothing changed; those are already the settings.";
  const label = changes.map((c) => (c === "training settings" ? `training settings (${frequencyLabel({ ...cfg, ...config } as PlanConfig)})` : c)).join(", ");
  ctx.actions.push({
    kind: "plan",
    summary: `Updated ${label}`,
    planId: plan.id,
    versionBefore,
    prevConfig: cfg,
    prevGoal: { name: g.name, target_time_s: g.target_time_s, target_weekly_km: g.target_weekly_km },
  });
  const { data: next } = await ctx.db.from("planned_workouts").select("date, title, duration_s, type, status").eq("plan_id", plan.id).gte("date", ctx.today).lte("date", addDaysIso(ctx.today, 13)).order("date");
  const lines = (next ?? []).filter((w: any) => w.status === "planned" && w.type !== "rest").map((w: any) => `- ${w.date} ${w.title}, ${Math.round(w.duration_s / 60)} min`);
  return [`Done: updated ${label}.${changes.includes("training settings") ? " The rest of the plan was recalculated." : ""}`, "Next two weeks now:", ...lines].join("\n");
}

/** Increases that go beyond what the athlete has recently been doing. */
async function settingsRisks(ctx: ToolContext, cfg: PlanConfig, g: any, config: NonNullable<GoalEdit["config"]>, edit: GoalEdit): Promise<string[]> {
  const runs = await loadRuns(ctx.db, ctx.userId, addDaysIso(ctx.today, -35), ctx.today, 400);
  const weeks = weeklyTotals(runs, ctx.today, 5).slice(0, 4); // the last 4 complete-ish weeks before this one
  const avgMin = weeks.reduce((a, w) => a + w.minutes, 0) / Math.max(1, weeks.length);
  const avgKm = weeks.reduce((a, w) => a + w.km, 0) / Math.max(1, weeks.length);
  const avgRuns = weeks.reduce((a, w) => a + w.runs, 0) / Math.max(1, weeks.length);
  const out: string[] = [];
  const newRpw = config.runsPerWeek;
  if (newRpw && newRpw > (cfg.runsPerWeek ?? 0) && newRpw > Math.ceil(avgRuns) + 1)
    out.push(`${newRpw} runs a week, while the last 4 weeks averaged ${avgRuns.toFixed(1)} runs a week.`);
  const cap = config.maxWeeklyMinutes;
  if (cap && cap > (cfg.maxWeeklyMinutes ?? 0) && cap > avgMin * 1.2)
    out.push(`a weekly cap of ${Math.round(cap / 60 * 10) / 10} h allows more than 20 % above the recent average of ${Math.round(avgMin)} min a week (the planner still ramps gradually, but the cap no longer protects them).`);
  if (config.includeIntervals && !cfg.includeIntervals) out.push("adds interval sessions; check that recent easy runs feel easy and nothing hurts.");
  if (config.includeLongRuns && !cfg.includeLongRuns) out.push("adds long runs back into the plan.");
  if (edit.targetWeeklyKm && edit.targetWeeklyKm > (g.target_weekly_km ?? 0) && edit.targetWeeklyKm > avgKm * 1.3)
    out.push(`a target of ${edit.targetWeeklyKm} km a week, against a recent average of ${avgKm.toFixed(1)} km.`);
  if (edit.targetTimeS && g.target_time_s && edit.targetTimeS < g.target_time_s * 0.98) {
    const { data: st } = await ctx.db.from("fitness_state").select("output").eq("user_id", ctx.userId).maybeSingle();
    const dist = g.distance_m;
    const pred = (st?.output?.predictions ?? []).find((p: any) => Math.abs((p.distanceM ?? 0) - dist) < 50);
    out.push(`a faster target (${fmtTime(edit.targetTimeS)}, was ${fmtTime(g.target_time_s)}) makes race-pace sessions harder${pred ? `; the current prediction is ${fmtTime(pred.timeS)} (${fmtTime(pred.fastS)}–${fmtTime(pred.slowS)})` : ""}.`);
  }
  return out;
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


/** "Threshold 3 × 8 min (52 min)", but not "40 min easy (40 min)". */
const withMinutes = (title: string, durationS: number) => (/^\d+ min/.test(title) ? title : `${title} (${Math.round(durationS / 60)} min)`);

function goalKey(plan: any): string | null {
  return plan.goal?.kind ?? null;
}

/** Builds a session the way the planner would. */
function buildSession(plan: any, type: WorkoutType, minutes: number | null, intensity: number | null) {
  const b = buildWorkout({ type, minutes: minutes ?? undefined, progress: intensity ?? 0.5, goalKey: goalKey(plan), withRacePace: type === "progressive_long" && Boolean(plan.race_pace) }, planContext(plan));
  return { ...b, durationS: stepsDuration(b.steps), distanceM: stepsDistance(b.steps) };
}

async function scheduleIssues(ctx: ToolContext, plan: any, id: string | null, date: string, type: WorkoutType): Promise<string[]> {
  const { data: all } = await ctx.db.from("planned_workouts").select("id, date, type, status").eq("plan_id", plan.id).gte("date", addDaysIso(date, -7)).lte("date", addDaysIso(date, 7));
  const items = (all ?? []).filter((x: any) => x.id !== id).concat([{ id: id ?? "new", date, type, status: "planned" }]);
  const before = validateSchedule((all ?? []) as any, plan.config?.unavailableDays ?? []).map((i) => i.message);
  return validateSchedule(items as any, plan.config?.unavailableDays ?? [])
    .map((i) => i.message)
    .filter((m) => !before.includes(m));
}

async function replaceTool(ctx: ToolContext, input: z.infer<(typeof schemas)["replace_workout"]>): Promise<string> {
  const found = await ownWorkout(ctx, input.workout_id);
  if ("error" in found) return found.error;
  const { plan, w } = found;
  const label = `${w.title} (${formatDay(w.date)})`;
  if (w.status !== "planned" || w.date < ctx.today) return `Not changed: ${label} is ${w.date < ctx.today ? "in the past" : w.status}.`;
  if (w.type === "race") return "The race itself can't be changed from here.";
  if (w.locked) return `Not changed: the athlete locked ${label}. Unlock it first if they want it changed.`;
  const type = input.type as WorkoutType;
  const b = buildSession(plan, type, input.minutes, input.intensity);
  if (!input.confirmed && type !== "rest") {
    const issues = [...(await loadIssues(ctx.db, ctx.userId, plan, w.date, type, b.steps, w.id)), ...(HARD_TYPES.includes(type) ? await scheduleIssues(ctx, plan, w.id, w.date, type) : [])];
    if (issues.length) return `Not changed yet. The app's checks found:\n${issues.map((i) => `- ${i}`).join("\n")}\nExplain the risk to the athlete with their numbers and offer a safer version; only call again with confirmed true if they still want it.`;
  }
  await check(
    ctx.db
      .from("planned_workouts")
      .update({ type, title: b.title, objective: b.objective, why: `Changed from ${WORKOUT_LABEL[w.type as WorkoutType].toLowerCase()} by your coach.`, steps: b.steps, duration_s: b.durationS, distance_m: b.distanceM, key: HARD_TYPES.includes(type) || type === "long" || type === "progressive_long", source: "athlete" })
      .eq("id", w.id),
  );
  const summary = `Changed ${label} to ${type === "rest" ? "rest" : withMinutes(b.title, b.durationS)}`;
  await snapshot(ctx.db, ctx.userId, plan.id, summary, "athlete");
  ctx.actions.push({ kind: "plan", summary, planId: plan.id, versionBefore: plan.current_version });
  return `Done: ${summary}.`;
}

async function addTool(ctx: ToolContext, input: z.infer<(typeof schemas)["add_workout"]>): Promise<string> {
  const plan = await loadActivePlan(ctx.db, ctx.userId);
  if (!plan) return "There is no active plan. The athlete can create one on the Plan tab.";
  if (input.date < ctx.today) return "Can't add a session in the past.";
  const { data: last } = await ctx.db.from("planned_workouts").select("date").eq("plan_id", plan.id).order("date", { ascending: false }).limit(1).maybeSingle();
  if (last && input.date > last.date) return `That's after the plan ends (${last.date}).`;
  const type = input.type as WorkoutType;
  if (type === "rest") return "Rest days don't need adding; skip or swap a session instead.";
  const b = buildSession(plan, type, input.minutes, input.intensity);
  // a rest day on that date is replaced rather than doubled up
  const { data: same } = await ctx.db.from("planned_workouts").select("id, type, status").eq("plan_id", plan.id).eq("date", input.date);
  const restDay = (same ?? []).find((x: any) => x.type === "rest" && x.status === "planned");
  if (!input.confirmed) {
    const issues = [
      ...(await loadIssues(ctx.db, ctx.userId, plan, input.date, type, b.steps, restDay?.id ?? null)),
      ...(await scheduleIssues(ctx, plan, restDay?.id ?? null, input.date, type)),
    ];
    if (issues.length) return `Not added yet. The app's checks found:\n${issues.map((i) => `- ${i}`).join("\n")}\nExplain the risk to the athlete with their numbers and offer a safer version; only call again with confirmed true if they still want it.`;
  }
  const row = {
    type,
    title: b.title,
    objective: b.objective,
    why: "Added by your coach.",
    steps: b.steps,
    duration_s: b.durationS,
    distance_m: b.distanceM,
    key: HARD_TYPES.includes(type) || type === "long" || type === "progressive_long",
    source: "athlete" as const,
  };
  if (restDay) await check(ctx.db.from("planned_workouts").update(row).eq("id", restDay.id));
  else await check(ctx.db.from("planned_workouts").insert({ ...row, plan_id: plan.id, user_id: ctx.userId, date: input.date, original_date: input.date, status: "planned" }));
  const summary = `Added ${withMinutes(b.title, b.durationS)} on ${formatDay(input.date)}`;
  await snapshot(ctx.db, ctx.userId, plan.id, summary, "athlete");
  ctx.actions.push({ kind: "plan", summary, planId: plan.id, versionBefore: plan.current_version });
  return `Done: ${summary}.`;
}
