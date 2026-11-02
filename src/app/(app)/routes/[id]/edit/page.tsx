import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { RoutePlanner } from "@/components/routes/planner";
import { getRoute, recentRunTracks } from "@/lib/db/queries";

export const metadata = { title: "Edit route" };
export const dynamic = "force-dynamic";

export default async function EditRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [r, runs] = await Promise.all([getRoute(id), recentRunTracks()]);
  if (!r) notFound();
  if (r.source === "activity") redirect(`/routes/${id}`);
  return (
    <>
      <PageHeader back={{ href: `/routes/${id}`, label: r.name }} title="Edit route" />
      <RoutePlanner
        initial={{ id: r.id, name: r.name, waypoints: r.waypoints, snapped: r.snapped, coords: r.coords, source: r.source }}
        center={r.coords[0] ?? null}
        runs={runs}
      />
    </>
  );
}
