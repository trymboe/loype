import Link from "next/link";
import { Activity } from "lucide-react";
import { ActivityRow } from "@/components/activity-row";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { SyncButton } from "@/components/sync/sync-button";
import { listActivities } from "@/lib/db/queries";
import { formatDay, weekStart } from "@/lib/dates";
import { formatKm } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const metadata = { title: "Activities" };
export const dynamic = "force-dynamic";

const PAGE = 40;

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const { before } = await searchParams;
  const [acts, tz] = await Promise.all([listActivities(PAGE, before), userTimezone()]);
  if (acts.length === 0 && !before) {
    return (
      <>
        <PageHeader title="Activities" />
        <EmptyState icon={<Activity size={22} />} title="No runs imported yet" action={<ButtonLink href="/more/integrations">Connect your watch</ButtonLink>} />
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
      <PageHeader title="Activities" action={<SyncButton className="mb-1" />} />
      <div className="stagger space-y-7">
        {[...groups.entries()].map(([week, list]) => (
          <section key={week}>
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h2 className="section-title">Week of {formatDay(week, { day: "numeric", month: "short", year: "numeric" })}</h2>
              <span className="tabular text-xs text-muted">
                {list.length} {list.length === 1 ? "run" : "runs"} · {formatKm(list.reduce((s, a) => s + (a.distance_m ?? 0), 0), 1)} km
              </span>
            </div>
            <div className="card divide-hairline overflow-hidden">
              {list.map((a) => (
                <ActivityRow key={a.id} a={a} tz={tz} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {acts.length === PAGE && (
        <div className="mt-8 text-center">
          <Link href={`/activities?before=${encodeURIComponent(acts[acts.length - 1].start_time)}`} className="btn btn-secondary btn-sm">
            Older runs
          </Link>
        </div>
      )}
    </>
  );
}
