import { PageHeader } from "@/components/ui";
import { RoutePlanner } from "@/components/routes/planner";
import { recentRunTracks } from "@/lib/db/queries";
import { parsePlannerParams } from "@/lib/routes/suggest";

export const metadata = { title: "Plan a route" };
export const dynamic = "force-dynamic";

export default async function NewRoutePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [runs, preset] = await Promise.all([recentRunTracks(), searchParams.then(parsePlannerParams)]);
  // centre on where you last ran
  const center = runs[0]?.[0] ?? null;
  return (
    <>
      <PageHeader back={{ href: "/routes", label: "Routes" }} title="Plan a route" />
      <RoutePlanner initial={null} center={center} runs={runs} preset={preset} />
    </>
  );
}
