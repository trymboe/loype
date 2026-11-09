import Link from "@/components/link";
import { Award, CalendarCheck, Flame, Gauge, Medal, Route, Sigma } from "lucide-react";
import { Badge, Card, CardHeader, IconTile } from "@/components/ui";
import { formatDay } from "@/lib/dates";
import type { Milestone, MilestoneKind } from "@/lib/progress/milestones";

const ICON: Record<MilestoneKind, { icon: typeof Award; color: string }> = {
  distance: { icon: Route, color: "var(--long)" },
  effort: { icon: Medal, color: "var(--intervals)" },
  volume: { icon: Flame, color: "var(--tempo)" },
  consistency: { icon: CalendarCheck, color: "var(--good)" },
  fitness: { icon: Gauge, color: "var(--accent)" },
  total: { icon: Sigma, color: "var(--pace)" },
};

export function MilestonesCard({ milestones }: { milestones: Milestone[] }) {
  if (!milestones.length) return null;
  return (
    <Card>
      <CardHeader title="Personal milestones" aside={`${milestones.filter((m) => m.isNew).length || "No"} new in 2 weeks`} />
      <ul className="divide-hairline mt-2">
        {milestones.map((m) => {
          const { icon: Icon, color } = ICON[m.kind];
          const body = (
            <>
              <IconTile color={color}>
                <Icon size={17} />
              </IconTile>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{m.title}</span>
                  {m.isNew && <Badge tone="accent">New</Badge>}
                </p>
                <p className="truncate text-xs text-muted">
                  {[m.detail, formatDay(m.date, { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="tabular shrink-0 text-[0.9375rem] font-semibold">{m.value}</span>
            </>
          );
          return (
            <li key={m.key}>
              {m.activityId ? (
                <Link href={`/activities/${m.activityId}`} className="-mx-1 flex items-center gap-3 rounded-xl px-1 py-2.5 hover:bg-surface-2/50">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
