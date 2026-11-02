"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { confirmOnWatch, pushPlannedWorkouts } from "@/lib/outbound/service";
import { userTimezone } from "@/lib/user-tz";

export interface WatchState {
  ok?: boolean;
  error?: string;
}

const Id = z.string().uuid();

export async function watchAction(_prev: WatchState, form: FormData): Promise<WatchState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const id = Id.safeParse(form.get("id"));
  if (!id.success) return { error: "Unknown workout" };
  const op = form.get("op");
  const db = createAdminClient();
  // ownership: the workout must belong to this user
  const { data: w } = await db.from("planned_workouts").select("id").eq("id", id.data).eq("user_id", user.id).maybeSingle();
  if (!w) return { error: "Unknown workout" };
  if (op === "send") {
    const res = await pushPlannedWorkouts(db, user.id, todayIn(await userTimezone()), { force: true, onlyWorkoutId: id.data });
    revalidatePath(`/plan/workouts/${id.data}`);
    if (!res.configured) return { error: "Connect Intervals.icu under More → Integrations first." };
    if (res.error) return { error: res.error };
    if (res.failed) return { error: "Intervals.icu didn't accept the workout. See the error above." };
    return { ok: true };
  }
  if (op === "confirm" || op === "unconfirm") {
    const done = await confirmOnWatch(db, user.id, id.data, op === "confirm");
    revalidatePath(`/plan/workouts/${id.data}`);
    return done ? { ok: true } : { error: "Send the workout first." };
  }
  return { error: "Unknown action" };
}
