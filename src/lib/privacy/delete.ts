import type { SupabaseClient } from "@supabase/supabase-js";
// original activity files are stored as `<userId>/...` in this bucket
import { RAW_BUCKET } from "../ingest/supabase-repo";

export type DeleteScope = "training" | "everything";

/**
 * Tables kept when only training data is deleted: who you are, the Garmin
 * connection (so a fresh import is one tap away) and the calendar link.
 * Every other table with a user_id column is cleared, including ones added
 * after this was written (the database function discovers them).
 */
export const KEEP_FOR_TRAINING = ["athlete_profile", "integrations", "calendar_feeds"];

export const keepFor = (scope: DeleteScope) => (scope === "training" ? KEEP_FOR_TRAINING : []);

/** Integration settings that describe imported data and must go with it. */
const SYNC_BOOKKEEPING = ["wellnessBackfillFrom", "lastWellnessSyncAt", "lastWellnessErrors"];

export interface DeleteResult {
  rows: Record<string, number>;
  files: number;
  /** files that could not be removed (the rows are gone either way) */
  fileError: string | null;
}

type Storage = Pick<SupabaseClient["storage"], "from">;

/** Every object path under `prefix/` in the bucket, walking folders. */
export async function listAllFiles(storage: Storage, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [prefix];
  while (queue.length) {
    const dir = queue.shift()!;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await storage.from(bucket).list(dir, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`Storage list failed: ${error.message}`);
      const items = data ?? [];
      for (const it of items) {
        const path = `${dir}/${it.name}`;
        // folders come back without an id
        if (it.id == null) queue.push(path);
        else out.push(path);
      }
      if (items.length < 1000) break;
    }
  }
  return out;
}

export async function removeFiles(storage: Storage, bucket: string, paths: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await storage.from(bucket).remove(chunk);
    if (error) throw new Error(`Storage remove failed: ${error.message}`);
    n += chunk.length;
  }
  return n;
}

/**
 * Deletes the athlete's data. Rows first (one transaction in the database),
 * then the original files; if file removal fails it can simply be run again.
 * `db` must be the service-role client.
 */
export async function deleteUserData(db: SupabaseClient, userId: string, scope: DeleteScope): Promise<DeleteResult> {
  const { data, error } = await db.rpc("delete_user_data", { p_user: userId, p_keep: keepFor(scope) });
  if (error) throw new Error(`Delete failed: ${error.message}`);
  const rows = (data ?? {}) as Record<string, number>;

  if (scope === "training") {
    const { data: integ } = await db.from("integrations").select("id, settings").eq("user_id", userId);
    for (const r of integ ?? []) {
      const settings = { ...(r.settings ?? {}) };
      for (const k of SYNC_BOOKKEEPING) delete settings[k];
      await db.from("integrations").update({ settings, last_success_at: null }).eq("id", r.id).eq("user_id", userId);
    }
  }

  let files = 0;
  let fileError: string | null = null;
  try {
    files = await removeFiles(db.storage, RAW_BUCKET, await listAllFiles(db.storage, RAW_BUCKET, userId));
  } catch (e) {
    fileError = e instanceof Error ? e.message : String(e);
  }
  return { rows, files, fileError };
}
