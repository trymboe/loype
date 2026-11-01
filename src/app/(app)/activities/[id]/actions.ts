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
  const parsed = Feedback.parse({
    activityId: form.get("activityId"),
    rpe: form.get("rpe"),
    legs: form.get("legs") || undefined,
    discomfort: form.get("discomfort") || undefined,
    notes: form.get("notes") || undefined,
  });
  const db = await createUserClient();
  const { error } = await db.from("workout_feedback").upsert(
    {
      activity_id: parsed.activityId,
      user_id: user.id,
      rpe: parsed.rpe,
      legs: parsed.legs ?? null,
      discomfort: parsed.discomfort ?? null,
      notes: parsed.notes ?? null,
    },
    { onConflict: "activity_id" },
  );
  if (error) throw new Error("Could not save your check-in");
  revalidatePath(`/activities/${parsed.activityId}`);
}
