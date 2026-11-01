"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createUserClient, getSessionUser } from "@/lib/db/server";

const Feedback = z.object({
  activityId: z.string().uuid(),
  rpe: z.coerce.number().int().min(1).max(10),
  legs: z.enum(["fresh", "normal", "heavy", "sore"]).optional(),
  discomfort: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

export async function saveFeedback(form: FormData) {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in");
  // Fields that were not rendered (note inputs collapsed) are absent from the form
  // and must keep their stored value rather than being wiped.
  const opt = (k: string) => (form.has(k) ? String(form.get(k) ?? "").trim() : undefined);
  const parsed = Feedback.parse({
    activityId: form.get("activityId"),
    rpe: form.get("rpe"),
    legs: form.get("legs") || undefined,
    discomfort: opt("discomfort"),
    notes: opt("notes"),
  });
  const row: Record<string, unknown> = {
    activity_id: parsed.activityId,
    user_id: user.id,
    rpe: parsed.rpe,
    legs: parsed.legs ?? null,
  };
  if (parsed.discomfort !== undefined) row.discomfort = parsed.discomfort || null;
  if (parsed.notes !== undefined) row.notes = parsed.notes || null;
  const db = await createUserClient();
  const { error } = await db.from("workout_feedback").upsert(row, { onConflict: "activity_id" });
  if (error) throw new Error("Could not save your check-in");
  revalidatePath(`/activities/${parsed.activityId}`);
}
