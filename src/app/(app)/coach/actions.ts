"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { undoCoachActions } from "@/lib/coach/service";
import { userTimezone } from "@/lib/user-tz";

/** Undo button under a coach reply: reverts the plan changes it made. */
export async function undoCoachAction(messageIds: string[]): Promise<{ ok?: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const ids = z.array(z.string().uuid()).min(1).max(20).safeParse(messageIds);
  if (!ids.success) return { error: "Nothing to undo" };
  try {
    const r = await undoCoachActions(createAdminClient(), user.id, ids.data, todayIn(await userTimezone()));
    if ("error" in r) return { error: r.error };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't undo" };
  }
  revalidatePath("/plan", "layout");
  revalidatePath("/coach");
  revalidatePath("/");
  return { ok: true };
}
