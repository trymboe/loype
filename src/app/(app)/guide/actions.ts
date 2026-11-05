"use server";

import { redirect } from "next/navigation";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { updatePreferences } from "@/lib/onboarding/facts";

/** Leaves the welcome guide for the guided setup; Today stops sending a new user here. */
export async function startSetupAction() {
  const u = await getSessionUser();
  if (!u) throw new Error("Not signed in");
  await updatePreferences(createAdminClient(), u.id, { onboarding: { guideSeenAt: new Date().toISOString() } });
  redirect("/welcome");
}
