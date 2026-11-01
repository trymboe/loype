"use server";

import { cookies } from "next/headers";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { TZ_COOKIE, isValidTimeZone } from "@/lib/tz";

/** Remembers the browser's time zone (cookie for rendering, profile for background jobs). */
export async function setTimezone(tz: string): Promise<boolean> {
  if (!isValidTimeZone(tz)) return false;
  const user = await getSessionUser();
  if (!user) return false;
  (await cookies()).set(TZ_COOKIE, tz, { path: "/", maxAge: 400 * 86400, sameSite: "lax", secure: true, httpOnly: false });
  const db = await createUserClient();
  await db.from("athlete_profile").upsert({ user_id: user.id, timezone: tz }, { onConflict: "user_id" });
  return true;
}
