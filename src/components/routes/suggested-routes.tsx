import Link from "next/link";
import { ChevronRight, Route as RouteIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { RouteThumb } from "@/components/route-thumb";
import { createUserClient } from "@/lib/db/server";
import { loopPlannerHref, prefersFlat, suggestRoutes, targetDistance, wantsRoute, type SuggestRoute, type SuggestWorkout } from "@/lib/routes/suggest";
import type { Step } from "@/lib/planning/types";
import { UseRouteButton } from "./use-route-button";

export interface SuggestFor {
  id: string;
  type: string;
  duration_s: number | null;
  distance_m: number | null;
  steps: Step[] | null;
  route_id?: string | null;
}

interface Row extends SuggestRoute {
  name: string;
  coords: [number, number][];
}

function thumb(coords: [number, number][]): [number, number][] {
  const stride = Math.max(1, Math.ceil(coords.length / 120));
  return coords.filter((_, i) => i % stride === 0 || i === coords.length - 1);
}

/** Saved routes that fit a planned workout, plus a link to generate a loop of the right length. */
export async function SuggestedRoutes({ workout, today, linkable = false }: { workout: SuggestFor; today: string; linkable?: boolean }) {
  const w: SuggestWorkout = { type: workout.type, durationS: workout.duration_s, distanceM: workout.distance_m, steps: workout.steps };
  if (!wantsRoute(w.type)) return null;
  const target = targetDistance(w);
  if (!target) return null;
  const db = await createUserClient();
  const [{ data: routes }, { data: used }] = await Promise.all([
    db.from("routes").select("id, name, coords, distance_m, elevation_gain_m, favorite, updated_at").order("updated_at", { ascending: false }).limit(200),
    db.from("planned_workouts").select("route_id, date").not("route_id", "is", null).lte("date", today).order("date", { ascending: false }).limit(200),
  ]);
  const lastRun = new Map<string, string>();
  for (const u of (used ?? []) as { route_id: string; date: string }[]) if (!lastRun.has(u.route_id)) lastRun.set(u.route_id, u.date);
  const rows: Row[] = ((routes ?? []) as { id: string; name: string; coords: [number, number][]; distance_m: number; elevation_gain_m: number | null; favorite: boolean; updated_at: string }[]).map((r) => {
    const runOn = lastRun.get(r.id);
    const edited = r.updated_at.slice(0, 10);
    return { id: r.id, name: r.name, coords: r.coords, distanceM: r.distance_m, elevationGainM: r.elevation_gain_m, favorite: r.favorite, lastUsed: runOn && runOn > edited ? runOn : edited };
  });
  const linked = workout.route_id ? rows.find((r) => r.id === workout.route_id) : undefined;
  const picks = linked ? [linked] : suggestRoutes(w, rows, { today }).map((s) => s.route);
  const loopHref = loopPlannerHref(target, prefersFlat(w.type));

  if (!picks.length) {
    return (
      <Link href={loopHref} className="card flex items-center gap-3 px-5 py-4 text-sm transition-colors hover:bg-surface-2/40">
        <RouteIcon size={18} className="text-muted" />
        <span className="flex-1 font-medium">Generate a {(target / 1000).toFixed(1)} km loop</span>
        <ChevronRight size={18} className="text-subtle" />
      </Link>
    );
  }
  return (
    <Card>
      <CardHeader
        title={linked ? "Route" : picks.length > 1 ? "Routes" : "Route"}
        aside={
          !linked && (
            <Link href={loopHref} className="inline-flex items-center gap-1 font-semibold text-accent">
              <RouteIcon size={14} /> Generate loop
            </Link>
          )
        }
      />
      <ul className="mt-3 space-y-1">
        {picks.map((r) => (
          <li key={r.id} className="flex items-center gap-3">
            <Link href={`/routes/${r.id}`} className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-2/60">
              <RouteThumb points={thumb(r.coords)} size={48} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem] font-semibold">{r.name}</span>
                <span className="tabular block text-[0.8125rem] text-muted">
                  {(r.distanceM / 1000).toFixed(1)} km{r.elevationGainM != null && ` · +${Math.round(r.elevationGainM)} m`}
                </span>
              </span>
            </Link>
            {linkable && !linked && <UseRouteButton routeId={r.id} workoutId={workout.id} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}
