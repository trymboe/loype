"use server";

import { revalidatePath } from "next/cache";
import { disableFeed, getFeed, rotateFeed, setFeedTime } from "@/lib/calendar/service";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { userTimezone } from "@/lib/user-tz";

async function user() {
  const u = await getSessionUser();
  if (!u) throw new Error("Not signed in");
  return u;
}

/** Turns the feed on, or replaces its secret link. */
export async function rotateFeedAction() {
  const u = await user();
  await rotateFeed(createAdminClient(), u.id, await userTimezone());
  revalidatePath("/more/calendar");
}

export async function disableFeedAction() {
  const u = await user();
  await disableFeed(createAdminClient(), u.id);
  revalidatePath("/more/calendar");
}

export interface TimeState {
  ok?: boolean;
  error?: string;
}

export async function setFeedTimeAction(_prev: TimeState, form: FormData): Promise<TimeState> {
  const u = await user();
  const mode = String(form.get("mode") ?? "allday");
  const time = String(form.get("time") ?? "").trim();
  if (mode === "timed" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "Pick a time like 07:00" };
  const db = createAdminClient();
  if (!(await getFeed(db, u.id))) return { error: "Turn the calendar feed on first" };
  await setFeedTime(db, u.id, mode === "timed" ? time : null, await userTimezone());
  revalidatePath("/more/calendar");
  return { ok: true };
}
