"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { elevationAlong } from "@/lib/routes/elevation";
import { simplify, type LngLat } from "@/lib/routes/geometry";
import { prepareRoute, type RouteDraft } from "@/lib/routes/prepare";
import { routingProvider } from "@/lib/routes/routing";

const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export interface SaveResult {
  error?: string;
  id?: string;
}

/** Creates or updates a route drawn in the planner. */
export async function saveRouteAction(input: RouteDraft & { id?: string | null; source?: "drawn" | "loop" }): Promise<SaveResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  if (input.id && !Id.safeParse(input.id).success) return { error: "Unknown route" };
  const prepared = prepareRoute(input);
  if ("error" in prepared) return { error: prepared.error };
  // The planner looks elevation up as you draw; if that failed, try once more here.
  if (!prepared.elevations) {
    try {
      const ele = await elevationAlong(routingProvider(), prepared.coords);
      const again = prepareRoute({ ...prepared, elevations: ele });
      if (!("error" in again)) Object.assign(prepared, again);
    } catch {
      // saved without elevation; the route page says so
    }
  }
  const db = createAdminClient();
  const row = {
    name: prepared.name,
    coords: prepared.coords,
    elevations: prepared.elevations,
    waypoints: prepared.waypoints,
    snapped: prepared.snapped,
    distance_m: prepared.distance_m,
    elevation_gain_m: prepared.elevation_gain_m,
    elevation_loss_m: prepared.elevation_loss_m,
    routing_provider: prepared.snapped.some(Boolean) ? routingProvider().name : null,
  };
  if (input.id) {
    const { data, error } = await db.from("routes").update(row).eq("id", input.id).eq("user_id", user.id).select("id").maybeSingle();
    if (error || !data) return { error: "Couldn't save the route" };
    revalidatePath("/routes");
    revalidatePath(`/routes/${input.id}`);
    return { id: input.id };
  }
  const { data, error } = await db
    .from("routes")
    .insert({ ...row, user_id: user.id, source: input.source === "loop" ? "loop" : "drawn" })
    .select("id")
    .single();
  if (error || !data) return { error: "Couldn't save the route" };
  revalidatePath("/routes");
  return { id: data.id };
}

export async function toggleFavoriteAction(id: string, favorite: boolean) {
  const user = await getSessionUser();
  if (!user || !Id.safeParse(id).success) return;
  await createAdminClient().from("routes").update({ favorite }).eq("id", id).eq("user_id", user.id);
  revalidatePath("/routes");
  revalidatePath(`/routes/${id}`);
}

export async function renameRouteAction(id: string, name: string): Promise<SaveResult> {
  const user = await getSessionUser();
  if (!user || !Id.safeParse(id).success) return { error: "Unknown route" };
  const n = name.trim().slice(0, 80);
  if (!n) return { error: "Give the route a name" };
  await createAdminClient().from("routes").update({ name: n }).eq("id", id).eq("user_id", user.id);
  revalidatePath("/routes");
  revalidatePath(`/routes/${id}`);
  return { id };
}

export async function deleteRouteAction(id: string) {
  const user = await getSessionUser();
  if (!user || !Id.safeParse(id).success) return;
  await createAdminClient().from("routes").delete().eq("id", id).eq("user_id", user.id);
  revalidatePath("/routes");
  redirect("/routes");
}

/** Links a route to a planned workout (or unlinks with workoutId = null). One route per workout. */
export async function linkWorkoutAction(routeId: string, workoutId: string, link: boolean): Promise<SaveResult> {
  const user = await getSessionUser();
  if (!user || !Id.safeParse(routeId).success || !Id.safeParse(workoutId).success) return { error: "Unknown workout" };
  const db = createAdminClient();
  const { data: r } = await db.from("routes").select("id").eq("id", routeId).eq("user_id", user.id).maybeSingle();
  if (!r) return { error: "Unknown route" };
  let q = db.from("planned_workouts").update({ route_id: link ? routeId : null }).eq("id", workoutId).eq("user_id", user.id);
  if (!link) q = q.eq("route_id", routeId);
  const { error } = await q;
  if (error) return { error: "Couldn't update the workout" };
  revalidatePath(`/routes/${routeId}`);
  revalidatePath(`/plan/workouts/${workoutId}`);
  revalidatePath("/plan");
  return { id: routeId };
}

/** Saves the GPS track of a recorded run as a route (to repeat it, export it or link it to a workout). */
export async function saveActivityAsRouteAction(activityId: string) {
  const user = await getSessionUser();
  if (!user || !Id.safeParse(activityId).success) return;
  const db = createAdminClient();
  const { data: existing } = await db.from("routes").select("id").eq("user_id", user.id).eq("activity_id", activityId).maybeSingle();
  if (existing) redirect(`/routes/${existing.id}`);
  const [{ data: a }, { data: s }] = await Promise.all([
    db.from("activities").select("name, local_date").eq("id", activityId).eq("user_id", user.id).maybeSingle(),
    db.from("activity_streams").select("lat, lng, altitude").eq("activity_id", activityId).maybeSingle(),
  ]);
  if (!a || !s?.lat || !s?.lng) return;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < s.lat.length; i++) if (s.lat[i] != null && s.lng[i] != null) pts.push([s.lng[i], s.lat[i], i]);
  if (pts.length < 2) return;
  // GPS noise is a few metres: simplify harder than planned routes
  const kept = simplify(pts, 4);
  const coords = kept.map(([lng, lat]) => [lng, lat] as LngLat);
  const elevations = s.altitude ? kept.map(([, , i]) => (s.altitude[i] as number | null) ?? null) : null;
  const prepared = prepareRoute({ name: a.name ?? `Run ${a.local_date}`, coords, elevations, waypoints: [coords[0], coords[coords.length - 1]], snapped: [false] });
  if ("error" in prepared) return;
  const { data, error } = await db
    .from("routes")
    .insert({
      user_id: user.id,
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
  if (error || !data) return;
  revalidatePath("/routes");
  redirect(`/routes/${data.id}`);
}
