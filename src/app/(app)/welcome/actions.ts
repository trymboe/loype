"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { recomputeFitness } from "@/lib/fitness/service";
import { loadPreferences, updatePreferences } from "@/lib/onboarding/facts";
import { EXPERIENCE_LABEL } from "@/lib/onboarding/state";
import { userTimezone } from "@/lib/user-tz";

async function user() {
  const u = await getSessionUser();
  if (!u) throw new Error("Not signed in");
  return u;
}

export async function markBaselineSeenAction() {
  const u = await user();
  await updatePreferences(createAdminClient(), u.id, { onboarding: { baselineSeenAt: new Date().toISOString() } });
  revalidatePath("/welcome");
  redirect("/welcome");
}

/** "Skip the rest": hides the setup prompt on Today. */
export async function dismissSetupAction() {
  const u = await user();
  await updatePreferences(createAdminClient(), u.id, { onboarding: { dismissedAt: new Date().toISOString() } });
  revalidatePath("/");
  redirect("/");
}

const opt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(min).max(max).nullable());

const About = z.object({
  max_hr: opt(100, 240),
  resting_hr: opt(25, 120),
  birth_year: opt(1900, 2100),
  sex: z.preprocess((v) => (v === "" || v == null ? null : v), z.enum(["female", "male", "other"]).nullable()),
  experience: z.enum(Object.keys(EXPERIENCE_LABEL) as [string, ...string[]], { message: "Pick your running experience" }),
  injury_note: z.string().trim().max(500).optional(),
});

export interface AboutState {
  error?: string;
}

export async function saveAboutAction(_prev: AboutState, form: FormData): Promise<AboutState> {
  const u = await getSessionUser();
  if (!u) return { error: "Not signed in" };
  const get = (k: string) => form.get(k) ?? undefined;
  const parsed = About.safeParse({
    max_hr: get("max_hr"),
    resting_hr: get("resting_hr"),
    birth_year: get("birth_year"),
    sex: get("sex"),
    experience: get("experience"),
    injury_note: get("injury_note"),
  });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { error: i?.path[0] === "experience" ? i.message : `Check ${String(i?.path[0] ?? "the form").replace("_", " ")}: ${i?.message}` };
  }
  const p = parsed.data;
  if (p.max_hr && p.resting_hr && p.max_hr <= p.resting_hr + 40) return { error: "Max HR should be well above resting HR." };
  const injuryConcern = form.get("injury") === "on";

  const db = createAdminClient();
  const { data: before } = await db.from("athlete_profile").select("max_hr, max_hr_source, resting_hr, resting_hr_source").eq("user_id", u.id).maybeSingle();
  // Empty HR fields keep whatever Løype detected; only typed values become manual overrides.
  const hr: Record<string, unknown> = {};
  if (p.max_hr) Object.assign(hr, { max_hr: p.max_hr, max_hr_source: "manual" });
  if (p.resting_hr) Object.assign(hr, { resting_hr: p.resting_hr, resting_hr_source: "manual" });
  const prefs = await loadPreferences(db, u.id);
  const { error } = await db.from("athlete_profile").upsert({
    user_id: u.id,
    ...hr,
    ...(p.birth_year ? { birth_year: p.birth_year } : {}),
    ...(p.sex ? { sex: p.sex } : {}),
    preferences: {
      ...prefs,
      athlete: {
        ...(prefs.athlete ?? {}),
        experience: p.experience,
        injuryConcern,
        injuryNote: injuryConcern ? p.injury_note || null : null,
        intervals: form.get("intervals") === "on",
        longRuns: form.get("long_runs") === "on",
      },
      onboarding: { ...(prefs.onboarding ?? {}), aboutDoneAt: new Date().toISOString() },
    },
  });
  if (error) return { error: `Could not save (${error.message})` };

  const hrChanged = (p.max_hr && p.max_hr !== before?.max_hr) || (p.resting_hr && p.resting_hr !== before?.resting_hr) || p.birth_year || p.sex;
  if (hrChanged) {
    try {
      await recomputeFitness(db, u.id, todayIn(await userTimezone()));
    } catch {
      // saved; the model catches up on the next sync
    }
  }
  revalidatePath("/welcome");
  revalidatePath("/plan/new");
  redirect("/welcome");
}
