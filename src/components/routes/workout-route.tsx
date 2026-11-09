import Link from "@/components/link";
import { ChevronRight, Map as MapIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { RouteThumb } from "@/components/route-thumb";
import { createUserClient } from "@/lib/db/server";
import { OpenInGoogleMaps } from "./google-maps";

/** The route linked to a planned workout, or a pointer to pick one. */
export async function WorkoutRoute({ routeId }: { routeId: string | null }) {
  if (!routeId) {
    return (
      <Link href="/routes" className="card flex items-center gap-3 px-5 py-4 text-sm transition-colors hover:bg-surface-2/40">
        <MapIcon size={18} className="text-muted" />
        <span className="flex-1 text-muted">Pick a route for this run</span>
        <ChevronRight size={18} className="text-subtle" />
      </Link>
    );
  }
  const db = await createUserClient();
  const { data: r } = await db.from("routes").select("id, name, coords, distance_m, elevation_gain_m").eq("id", routeId).maybeSingle();
  if (!r) return null;
  const coords = r.coords as [number, number][];
  const stride = Math.max(1, Math.ceil(coords.length / 120));
  return (
    <div className="space-y-2">
      <Card href={`/routes/${r.id}`}>
        <CardHeader title="Route" aside={<ChevronRight size={18} className="text-subtle" />} />
        <div className="mt-3 flex items-center gap-3.5">
          <RouteThumb points={coords.filter((_, i) => i % stride === 0 || i === coords.length - 1)} size={64} />
          <div className="min-w-0">
            <p className="truncate font-semibold">{r.name}</p>
            <p className="tabular text-sm text-muted">
              {(r.distance_m / 1000).toFixed(1)} km{r.elevation_gain_m != null && ` · +${Math.round(r.elevation_gain_m)} m`}
            </p>
          </div>
        </div>
      </Card>
      <OpenInGoogleMaps coords={coords} />
    </div>
  );
}
