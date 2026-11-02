import { PageHeader } from "@/components/ui";
import { RoutePlanner } from "@/components/routes/planner";
import { recentRunTracks } from "@/lib/db/queries";

export const metadata = { title: "Plan a route" };
export const dynamic = "force-dynamic";

export default async function NewRoutePage() {
  const runs = await recentRunTracks();
  // centre on where you last ran
  const center = runs[0]?.[0] ?? null;
  return (
    <>
      <PageHeader back={{ href: "/routes", label: "Routes" }} title="Plan a route" />
      <RoutePlanner initial={null} center={center} runs={runs} />
    </>
  );
}
