"use server";

import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { markRecapSeen } from "@/lib/recap/service";

/** Closes the weekly recap so it doesn't open again on the next visit. */
export async function dismissWeeklyRecap(weekStartIso: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartIso)) return false;
  const user = await getSessionUser();
  if (!user) return false;
  await markRecapSeen(createAdminClient(), user.id, weekStartIso);
  return true;
}
