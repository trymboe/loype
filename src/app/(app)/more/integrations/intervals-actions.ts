"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { IntervalsAuthError } from "@/lib/integrations/intervals/client";
import { connectIntervals, disconnectIntervals, pushPlannedWorkouts } from "@/lib/outbound/service";
import { userTimezone } from "@/lib/user-tz";

const Form = z.object({
  apiKey: z.string().trim().min(8, "That doesn't look like an Intervals.icu API key"),
  athleteId: z.string().trim().regex(/^(i?\d+)?$/, "Athlete ID looks like i123456").optional().or(z.literal("")),
});

export interface IntervalsState {
  ok?: boolean;
  error?: string;
  message?: string;
}

export async function connectIntervalsAction(_prev: IntervalsState, form: FormData): Promise<IntervalsState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const parsed = Form.safeParse({ apiKey: form.get("apiKey"), athleteId: form.get("athleteId") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const db = createAdminClient();
  try {
    await connectIntervals(db, user.id, parsed.data.apiKey, parsed.data.athleteId || null);
  } catch (e) {
    return { error: e instanceof IntervalsAuthError ? "Intervals.icu rejected this key. Copy it again from Settings → Developer settings." : `Couldn't reach Intervals.icu: ${e instanceof Error ? e.message : e}` };
  }
  const res = await pushPlannedWorkouts(db, user.id, todayIn(await userTimezone()), { force: true });
  revalidatePath("/more/integrations");
  if (res.error) return { ok: true, error: res.error };
  return { ok: true, message: `Connected. ${describe(res)}` };
}

export async function pushNowAction(_prev: IntervalsState, _form: FormData): Promise<IntervalsState> {
  void _form;
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const res = await pushPlannedWorkouts(createAdminClient(), user.id, todayIn(await userTimezone()), { force: true });
  revalidatePath("/more/integrations");
  if (!res.configured) return { error: "Intervals.icu isn't connected" };
  if (res.error) return { error: res.error };
  return { ok: true, message: describe(res) };
}

export async function disconnectIntervalsAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  await disconnectIntervals(createAdminClient(), user.id);
  revalidatePath("/more/integrations");
}

function describe(r: { sent: number; removed: number; unchanged: number; failed: number }): string {
  const parts = [];
  parts.push(r.sent === 1 ? "1 workout sent" : `${r.sent} workouts sent`);
  if (r.unchanged) parts.push(`${r.unchanged} already up to date`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return `${parts.join(", ")}.`;
}
