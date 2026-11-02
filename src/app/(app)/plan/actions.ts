"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addDaysIso, todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { checkStepEdit, createPlan, decideProposal, editWorkout, restoreVersion, undoProposal } from "@/lib/planning/service";
import { editableSteps } from "@/lib/planning/edit-steps";
import { moveIssues } from "@/lib/planning/validate";
import type { Goal, GoalKind, PlanConfig } from "@/lib/planning/types";
import { userTimezone } from "@/lib/user-tz";

const KINDS = ["5k", "10k", "half", "marathon", "race", "general", "endurance", "consistency", "maintain", "volume"] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** "1:50:00", "50:00" or "50" (minutes) → seconds. */
function parseTime(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return NaN;
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

export interface PlanFormState {
  error?: string;
}

export async function createPlanAction(_prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const today = todayIn(await userTimezone());
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const days = (k: string) => form.getAll(k).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

  const kind = z.enum(KINDS).safeParse(s("kind"));
  if (!kind.success) return { error: "Choose a goal" };
  const k: GoalKind = kind.data;
  const raceKinds: GoalKind[] = ["5k", "10k", "half", "marathon", "race"];
  const raceDate = s("race_date") || null;
  if (raceDate && !DATE.safeParse(raceDate).success) return { error: "Check the race date" };
  if (raceDate && raceDate <= today) return { error: "The race date must be in the future" };
  if (k === "race" && !raceDate) return { error: "Add the race date" };
  let distanceM: number | null = null;
  if (k === "race") {
    const km = Number(s("distance_km").replace(",", "."));
    if (!Number.isFinite(km) || km < 1 || km > 100) return { error: "Add the race distance in km (1–100)" };
    distanceM = km * 1000;
  }
  const targetTimeS = raceKinds.includes(k) ? parseTime(s("target_time")) : null;
  if (targetTimeS != null && (!Number.isFinite(targetTimeS) || targetTimeS < 600)) return { error: "Write the target time as h:mm:ss or mm:ss" };
  const weeklyKm = k === "volume" && s("target_weekly_km") ? Number(s("target_weekly_km").replace(",", ".")) : null;
  if (weeklyKm != null && (!Number.isFinite(weeklyKm) || weeklyKm < 5 || weeklyKm > 200)) return { error: "Target weekly km should be between 5 and 200" };

  const runDays = days("run_days");
  if (runDays.length < 2) return { error: "Pick at least 2 days you could run" };
  const longRunDay = s("long_run_day") === "" ? null : Number(s("long_run_day"));
  const startDate = s("start_date") || today;
  if (!DATE.safeParse(startDate).success || startDate < today) return { error: "The start date can't be in the past" };
  const weeks = Number(s("weeks") || 12);
  const maxH = s("max_weekly_hours") ? Number(s("max_weekly_hours").replace(",", ".")) : null;
  if (maxH != null && (!Number.isFinite(maxH) || maxH < 1 || maxH > 20)) return { error: "Weekly time limit should be between 1 and 20 hours" };

  const goal: Goal = { kind: k, name: s("name") || null, distanceM, raceDate: raceKinds.includes(k) ? raceDate : null, targetTimeS, targetWeeklyKm: weeklyKm };
  const config: PlanConfig = {
    startDate,
    weeks: Number.isFinite(weeks) ? weeks : 12,
    runDays,
    longRunDay: longRunDay != null && Number.isInteger(longRunDay) ? longRunDay : null,
    // days you didn't tick count as unavailable, so moving a workout there gives a warning
    unavailableDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => !runDays.includes(d)),
    maxWeeklyMinutes: maxH ? Math.round(maxH * 60) : null,
    includeIntervals: form.get("intervals") === "on",
    includeLongRuns: form.get("long_runs") === "on",
    includeStrides: form.get("strides") === "on",
  };
  const db = createAdminClient();
  try {
    await createPlan(db, user.id, goal, config, today, form.get("replacing") ? "Goal changed" : "Plan created");
  } catch (e) {
    return { error: `Could not create the plan: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath("/plan");
  revalidatePath("/");
  redirect("/plan");
}

async function userOrThrow() {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in");
  return user;
}

export async function decideProposalAction(form: FormData) {
  const user = await userOrThrow();
  const id = z.string().uuid().parse(form.get("id"));
  // "modify": accept only the workouts left ticked
  const decision = form.get("decision");
  const only = decision === "modify" ? form.getAll("only").map(String).filter((x) => z.string().uuid().safeParse(x).success) : undefined;
  await decideProposal(createAdminClient(), user.id, id, decision === "accept" || decision === "modify", only);
  revalidatePath("/plan", "layout");
  revalidatePath("/");
  revalidatePath("/coach");
}

export async function undoProposalAction(form: FormData) {
  const user = await userOrThrow();
  const id = z.string().uuid().parse(form.get("id"));
  await undoProposal(createAdminClient(), user.id, id);
  revalidatePath("/plan", "layout");
  revalidatePath("/");
  revalidatePath("/coach");
}

export async function restoreVersionAction(form: FormData) {
  const user = await userOrThrow();
  const planId = z.string().uuid().parse(form.get("planId"));
  const version = z.coerce.number().int().min(1).parse(form.get("version"));
  await restoreVersion(createAdminClient(), user.id, planId, version);
  revalidatePath("/plan", "layout");
  revalidatePath("/");
}

export interface EditState {
  issues?: string[];
  /** the date the issues were found for; confirming only applies to that date */
  issuesFor?: string;
  error?: string;
  ok?: boolean;
}

export async function editWorkoutAction(_prev: EditState, form: FormData): Promise<EditState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Unknown workout" };
  const op = String(form.get("op"));
  const db = createAdminClient();
  try {
    if (op === "move") {
      const date = DATE.safeParse(String(form.get("date") ?? ""));
      if (!date.success) return { error: "Pick a date" };
      const today = todayIn(await userTimezone());
      if (date.data < today) return { error: "You can't move a workout into the past" };
      const { data: w } = await db.from("planned_workouts").select("plan_id, date").eq("id", id.data).eq("user_id", user.id).single();
      if (!w) return { error: "Unknown workout" };
      if (date.data === w.date) return { error: "That's the day it's already on" };
      if (date.data > addDaysIso(w.date, 14) || date.data < addDaysIso(w.date, -14)) return { error: "Move it at most two weeks" };
      if (form.get("confirm") !== "1") {
        const [{ data: all }, { data: plan }] = await Promise.all([
          db.from("planned_workouts").select("id, date, type, status").eq("plan_id", w.plan_id),
          db.from("training_plans").select("config").eq("id", w.plan_id).single(),
        ]);
        const issues = moveIssues(all ?? [], id.data, date.data, plan?.config?.unavailableDays ?? []);
        if (issues.length) return { issues: issues.map((i) => i.message), issuesFor: date.data };
      }
      await editWorkout(db, user.id, id.data, { kind: "move", date: date.data });
    } else if (op === "lock" || op === "unlock") await editWorkout(db, user.id, id.data, { kind: "lock", locked: op === "lock" });
    else if (op === "skip") await editWorkout(db, user.id, id.data, { kind: "skip" });
    else if (op === "unskip") await editWorkout(db, user.id, id.data, { kind: "unskip" });
    else if (op === "easy" || op === "rest") await editWorkout(db, user.id, id.data, { kind: "swap", to: op });
    else if (op === "steps") {
      let raw: unknown;
      try {
        raw = JSON.parse(String(form.get("steps") ?? ""));
      } catch {
        return { error: "Couldn't read the steps" };
      }
      const parsed = editableSteps.safeParse(raw);
      if (!parsed.success) return { error: "Some steps are incomplete: every step needs a time or a distance." };
      const payload = String(form.get("steps"));
      if (form.get("confirm") !== "1") {
        const issues = await checkStepEdit(db, user.id, id.data, parsed.data);
        if (issues.length) return { issues, issuesFor: payload };
      }
      await editWorkout(db, user.id, id.data, { kind: "steps", steps: parsed.data });
    }
    else return { error: "Unknown action" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/plan", "layout");
  revalidatePath("/");
  return { ok: true };
}
