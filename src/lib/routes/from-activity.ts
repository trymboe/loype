import type { SupabaseClient } from "@supabase/supabase-js";
import { simplify, type LngLat } from "./geometry";
import { prepareRoute } from "./prepare";

/**
 * Saves the GPS track of a recorded run as a route. Returns the route id
 * (an existing one if the run was saved before), or an error.
 */
export async function routeFromActivity(db: SupabaseClient, userId: string, activityId: string): Promise<{ id: string; existed: boolean } | { error: string }> {
  const { data: existing } = await db.from("routes").select("id").eq("user_id", userId).eq("activity_id", activityId).maybeSingle();
  if (existing) return { id: existing.id, existed: true };
  const [{ data: a }, { data: s }] = await Promise.all([
    db.from("activities").select("name, local_date").eq("id", activityId).eq("user_id", userId).maybeSingle(),
    db.from("activity_streams").select("lat, lng, altitude").eq("activity_id", activityId).maybeSingle(),
  ]);
  if (!a) return { error: "Unknown run" };
  if (!s?.lat || !s?.lng) return { error: "This run has no GPS track" };
  const pts: [number, number, number][] = [];
  for (let i = 0; i < s.lat.length; i++) if (s.lat[i] != null && s.lng[i] != null) pts.push([s.lng[i], s.lat[i], i]);
  if (pts.length < 2) return { error: "This run has no usable GPS track" };
  // GPS noise is a few metres: simplify harder than planned routes
  const kept = simplify(pts, 4);
  const coords = kept.map(([lng, lat]) => [lng, lat] as LngLat);
  const elevations = s.altitude ? kept.map(([, , i]) => (s.altitude[i] as number | null) ?? null) : null;
  const prepared = prepareRoute({ name: a.name ?? `Run ${a.local_date}`, coords, elevations, waypoints: [coords[0], coords[coords.length - 1]], snapped: [false] });
  if ("error" in prepared) return { error: prepared.error };
  const { data, error } = await db
    .from("routes")
    .insert({
      user_id: userId,
      name: prepared.name,
      coords: prepared.coords,
      elevations: prepared.elevations,
      waypoints: prepared.waypoints,
      snapped: prepared.snapped,
      distance_m: prepared.distance_m,
      elevation_gain_m: prepared.elevation_gain_m,
      elevation_loss_m: prepared.elevation_loss_m,
      source: "activity",
      activity_id: activityId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "Couldn't save the route" };
  return { id: data.id, existed: false };
}
