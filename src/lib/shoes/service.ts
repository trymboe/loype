import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "../db/paginate";
import { defaultShoeFor, shoeMileage, type ShoeMileage, type ShoeRow, type ShoeRun } from "./mileage";

const SHOE_COLS = "id, name, brand, model, starting_distance_m, retire_at_distance_m, is_default, retired_at, created_at";

export async function listShoes(db: SupabaseClient, userId: string): Promise<ShoeRow[]> {
  const { data, error } = await db.from("shoes").select(SHOE_COLS).eq("user_id", userId).order("created_at");
  if (error) throw new Error(`Database error: ${error.message}`);
  return (data ?? []) as ShoeRow[];
}

/** Every shoe with its total distance (previous km + linked, non-duplicate runs). */
export async function listShoesWithMileage(db: SupabaseClient, userId: string): Promise<ShoeMileage[]> {
  const shoes = await listShoes(db, userId);
  if (!shoes.length) return [];
  const runs = await fetchAll<ShoeRun & { id: string }>((from, to) =>
    db
      .from("activities")
      .select("id, shoe_id, distance_m, duplicate_of")
      .eq("user_id", userId)
      .in("shoe_id", shoes.map((s) => s.id))
      .order("id")
      .range(from, to),
  );
  return shoeMileage(shoes, runs);
}

/**
 * Default shoe for a run being saved for the first time. Never throws: a
 * missing table or a read error must not stop an import.
 */
export async function defaultShoeIdFor(db: SupabaseClient, userId: string, start: Date): Promise<string | null> {
  try {
    const { data, error } = await db.from("shoes").select("id, is_default, retired_at, created_at").eq("user_id", userId).eq("is_default", true).limit(1);
    if (error || !data) return null;
    return defaultShoeFor(data as Parameters<typeof defaultShoeFor>[0], start);
  } catch {
    return null;
  }
}

/** Makes `shoeId` the only default (or clears the default with null). */
export async function setDefaultShoe(db: SupabaseClient, userId: string, shoeId: string | null) {
  // clear first: the partial unique index allows one default per athlete
  const cleared = await db.from("shoes").update({ is_default: false }).eq("user_id", userId).eq("is_default", true);
  if (cleared.error) throw new Error(`Database error: ${cleared.error.message}`);
  if (!shoeId) return;
  const set = await db.from("shoes").update({ is_default: true }).eq("id", shoeId).eq("user_id", userId).is("retired_at", null);
  if (set.error) throw new Error(`Database error: ${set.error.message}`);
}
