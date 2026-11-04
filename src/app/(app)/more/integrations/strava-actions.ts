"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { authorizeUrl } from "@/lib/integrations/strava/client";
import { disconnectStrava, getStravaIntegration, readCredentials, saveStravaApp, signState } from "@/lib/ingest/strava-service";

const AppForm = z.object({
  clientId: z.string().trim().regex(/^\d{1,12}$/, "The Client ID is a number, e.g. 123456"),
  clientSecret: z.string().trim().regex(/^[0-9a-f]{40}$/i, "The Client Secret is 40 letters and digits. Tap “Show” on strava.com/settings/api and copy it"),
});

export interface StravaState {
  error?: string;
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function goToStrava(userId: string, clientId: string): Promise<never> {
  const base = await origin();
  redirect(authorizeUrl({ clientId, redirectUri: `${base}/api/strava/callback`, state: signState(userId) }));
}

/** Saves the user's Strava API app, then sends them to Strava to approve access. */
export async function connectStravaAction(_prev: StravaState, form: FormData): Promise<StravaState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const parsed = AppForm.safeParse({ clientId: form.get("clientId"), clientSecret: form.get("clientSecret") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  await saveStravaApp(createAdminClient(), user.id, parsed.data);
  return goToStrava(user.id, parsed.data.clientId);
}

/** Re-runs the Strava approval with the app that is already saved. */
export async function reconnectStravaAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  const creds = readCredentials(await getStravaIntegration(createAdminClient(), user.id));
  if (!creds) return;
  await goToStrava(user.id, creds.clientId);
}

export async function disconnectStravaAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  await disconnectStrava(createAdminClient(), user.id);
  revalidatePath("/more/integrations");
  revalidatePath("/", "layout");
}
