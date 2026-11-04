"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { GarminAuthError } from "@/lib/integrations/garmin/client";
import { buildGarminClient, saveGarminApiKey } from "@/lib/ingest/service";

const KeyForm = z.object({
  apiKey: z.string().trim().min(10, "That doesn't look like a Personal API key"),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});

export interface KeyState {
  ok?: boolean;
  error?: string;
}

/** Stores the key encrypted, then verifies it by obtaining an access token. */
export async function connectGarmin(_prev: KeyState, form: FormData): Promise<KeyState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const parsed = KeyForm.safeParse({ apiKey: form.get("apiKey"), expiresAt: form.get("expiresAt") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const db = createAdminClient();
  await saveGarminApiKey(db, user.id, parsed.data.apiKey, parsed.data.expiresAt || null);
  try {
    const client = await buildGarminClient(db, user.id);
    await client!.getAccessToken(true);
  } catch (e) {
    const msg = e instanceof GarminAuthError ? "Garmin rejected this key. Check that you copied it completely." : "Saved, but Garmin couldn't be reached to verify it. Try syncing in a minute.";
    await db.from("integrations").update({ status: e instanceof GarminAuthError ? "needs_reauth" : "error", last_error: msg }).eq("user_id", user.id).eq("provider", "garmin");
    revalidatePath("/more/integrations");
    revalidatePath("/welcome");
    return { error: msg };
  }
  revalidatePath("/more/integrations");
  revalidatePath("/welcome");
  return { ok: true };
}
