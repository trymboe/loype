import "server-only";
import { cookies } from "next/headers";
import { createUserClient } from "./db/server";
import { DEFAULT_TZ, TZ_COOKIE, isValidTimeZone } from "./tz";

/**
 * The time zone "today" and "this week" are computed in.
 * Order: the browser's zone (cookie set by <TimezoneSync/>), the profile's
 * stored zone, then Europe/Oslo. Activities themselves are dated with the
 * UTC offset the watch recorded, so this only affects the calendar framing.
 */
export async function userTimezone(): Promise<string> {
  const fromCookie = (await cookies()).get(TZ_COOKIE)?.value;
  if (isValidTimeZone(fromCookie)) return fromCookie;
  try {
    const db = await createUserClient();
    const { data } = await db.from("athlete_profile").select("timezone").maybeSingle();
    if (isValidTimeZone(data?.timezone)) return data.timezone;
  } catch {
    // fall through to the default
  }
  return DEFAULT_TZ;
}
