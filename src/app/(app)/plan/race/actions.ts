"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { activePlan } from "@/lib/planning/service";
import { GPX_MAX_BYTES, GpxError, parseGpx } from "@/lib/race/gpx";

export interface CourseFormState {
  error?: string;
  ok?: string;
}

async function currentGoal() {
  const user = await getSessionUser();
  if (!user) return null;
  const db = createAdminClient();
  const plan = await activePlan(db, user.id);
  if (!plan?.goal) return null;
  return { db, userId: user.id, goalId: plan.goal.id as string };
}

export async function uploadCourseAction(_prev: CourseFormState, form: FormData): Promise<CourseFormState> {
  const ctx = await currentGoal();
  if (!ctx) return { error: "Set a race goal first." };
  const file = form.get("gpx");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a GPX file." };
  if (file.size > GPX_MAX_BYTES) return { error: "That file is larger than 5 MB." };
  let course;
  try {
    course = parseGpx(await file.text());
  } catch (e) {
    return { error: e instanceof GpxError ? e.message : "Couldn't read that GPX file." };
  }
  const { error } = await ctx.db.from("race_courses").upsert(
    {
      user_id: ctx.userId,
      goal_id: ctx.goalId,
      name: course.name,
      file_name: file.name.slice(0, 200),
      distance_m: course.distanceM,
      gain_m: course.gainM,
      loss_m: course.lossM,
      min_ele_m: course.minEleM,
      max_ele_m: course.maxEleM,
      points: course.points,
      created_at: new Date().toISOString(),
    },
    { onConflict: "goal_id" },
  );
  if (error) return { error: "Saving the course failed. Please try again." };
  revalidatePath("/plan/race");
  return { ok: `Course loaded: ${(course.distanceM / 1000).toFixed(2)} km${course.gainM != null ? `, ${course.gainM} m climbing` : ""}.` };
}

export async function removeCourseAction(): Promise<void> {
  const ctx = await currentGoal();
  if (!ctx) return;
  await ctx.db.from("race_courses").delete().eq("user_id", ctx.userId).eq("goal_id", ctx.goalId);
  revalidatePath("/plan/race");
}
