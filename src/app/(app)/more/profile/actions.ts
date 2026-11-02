"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { recomputeFitness } from "@/lib/fitness/service";
import { userTimezone } from "@/lib/user-tz";

const opt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(min).max(max).nullable());

const Profile = z.object({
  max_hr: opt(100, 240),
  resting_hr: opt(25, 120),
  birth_year: opt(1900, 2100),
  sex: z.preprocess((v) => (v === "" ? null : v), z.enum(["female", "male", "other"]).nullable()),
  weight_kg: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().min(20).max(300).nullable()),
});

export interface ProfileState {
  ok?: boolean;
  error?: string;
}

export async function saveProfile(_prev: ProfileState, form: FormData): Promise<ProfileState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const parsed = Profile.safeParse(Object.fromEntries(["max_hr", "resting_hr", "birth_year", "sex", "weight_kg"].map((k) => [k, form.get(k)])));
  if (!parsed.success) return { error: `Check ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}` };
  const p = parsed.data;
  if (p.max_hr && p.resting_hr && p.max_hr <= p.resting_hr + 40) return { error: "Max HR should be well above resting HR." };
  const db = createAdminClient();
  const { error } = await db.from("athlete_profile").upsert({
    user_id: user.id,
    ...p,
    // an empty field means "work it out from my data"
    max_hr_source: p.max_hr ? "manual" : null,
    resting_hr_source: p.resting_hr ? "manual" : null,
  });
  if (error) return { error: `Could not save (${error.message})` };
  try {
    await recomputeFitness(db, user.id, todayIn(await userTimezone()));
  } catch {
    // saved; the model will catch up on the next sync or Progress visit
  }
  revalidatePath("/progress");
  revalidatePath("/more/profile");
  return { ok: true };
}
