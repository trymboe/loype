import Link from "next/link";
import { Map as MapIcon, Plus, Star } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { RouteThumb } from "@/components/route-thumb";
import { listRoutes } from "@/lib/db/queries";

export const metadata = { title: "Routes" };
export const dynamic = "force-dynamic";

const SOURCE = { drawn: "Drawn", loop: "Generated loop", activity: "From a run" } as const;

export default async function RoutesPage() {
  const routes = await listRoutes();
  const newBtn = (
    <Link href="/routes/new" className="btn btn-primary btn-sm">
      <Plus size={16} /> New
    </Link>
  );
  return (
    <>
      <PageHeader title="Routes" action={routes.length ? newBtn : undefined} />
      {routes.length === 0 ? (
        <EmptyState
          icon={<MapIcon size={22} />}
          title="No routes yet"
          action={
            <Link href="/routes/new" className="btn btn-primary">
              <Plus size={16} /> Plan a route
            </Link>
          }
        />
      ) : (
        <ul className="card rise divide-hairline overflow-hidden">
          {routes.map((r) => (
            <li key={r.id}>
              <Link href={`/routes/${r.id}`} className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-surface-2/50 active:bg-surface-2">
                <RouteThumb points={thumb(r.coords)} size={56} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-[0.9375rem] font-semibold">
                    {r.favorite && <Star size={14} className="shrink-0 fill-[var(--warn)] text-warn" aria-label="Favourite" />}
                    <span className="truncate">{r.name}</span>
                  </p>
                  <p className="tabular mt-0.5 text-[0.8125rem] text-muted">
                    {(r.distance_m / 1000).toFixed(1)} km{r.elevation_gain_m != null && ` · +${Math.round(r.elevation_gain_m)} m`} · {SOURCE[r.source]}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function thumb(coords: [number, number][]): [number, number][] {
  const stride = Math.max(1, Math.ceil(coords.length / 120));
  return coords.filter((_, i) => i % stride === 0 || i === coords.length - 1);
}
