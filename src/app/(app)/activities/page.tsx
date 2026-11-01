import Link from "next/link";
import { ActivityRow } from "@/components/activity-row";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { listActivities } from "@/lib/db/queries";
import { formatDay, weekStart } from "@/lib/dates";
import { formatKm } from "@/lib/units";

export const metadata = { title: "Activities" };
export const dynamic = "force-dynamic";

const PAGE = 40;

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const { before } = await searchParams;
  const acts = await listActivities(PAGE, before);
  if (acts.length === 0 && !before) {
    return (
      <>
        <PageHeader title="Activities" />
        <EmptyState title="No runs imported yet" action={<ButtonLink href="/more/integrations">Connect Garmin</ButtonLink>}>
          Connect your Garmin account and import your history. Runs appear here automatically after every sync.
        </EmptyState>
      </>
    );
  }
  const groups = new Map<string, typeof acts>();
  for (const a of acts) {
    const w = weekStart(a.local_date);
    groups.set(w, [...(groups.get(w) ?? []), a]);
  }
  return (
    <>
      <PageHeader title="Activities" />
      <div className="space-y-6">
        {[...groups.entries()].map(([week, list]) => (
          <section key={week} className="rise">
            <div className="mb-1 flex items-baseline justify-between px-2">
              <h2 className="label">Week of {formatDay(week, { day: "numeric", month: "short", year: "numeric" })}</h2>
              <span className="tabular text-xs text-muted">
                {list.length} {list.length === 1 ? "run" : "runs"} · {formatKm(list.reduce((s, a) => s + (a.distance_m ?? 0), 0), 1)} km
              </span>
            </div>
            <div className="card divide-y divide-border px-2">
              {list.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {acts.length === PAGE && (
        <div className="mt-6 text-center">
          <Link href={`/activities?before=${encodeURIComponent(acts[acts.length - 1].start_time)}`} className="text-sm font-semibold text-accent">
            Older runs →
          </Link>
        </div>
      )}
    </>
  );
}
