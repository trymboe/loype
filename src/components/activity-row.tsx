import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ActivityListItem } from "@/lib/db/queries";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatKm, formatPaceFromSpeed } from "@/lib/units";
import { RouteThumb } from "./route-thumb";
import { Badge } from "./ui";

export function ActivityRow({ a, tz }: { a: ActivityListItem; tz?: string }) {
  const hr = a.avg_hr ? Math.round(a.avg_hr) : null;
  return (
    <Link href={`/activities/${a.id}`} className="group flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-surface-2/50 active:bg-surface-2">
      <RouteThumb points={a.route_preview} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em]">{a.name ?? "Run"}</p>
          {a.sport !== "running" && <Badge>{a.sport.replace(/_/g, " ")}</Badge>}
          {a.is_indoor && <Badge>Indoor</Badge>}
          {!a.usable_for_fitness && <Badge tone="warn">Data issues</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {formatDay(a.local_date, { weekday: "short", day: "numeric", month: "short" })} · {localTime(a.start_time, a.utc_offset_s, tz)}
        </p>
        {/* phones: stats on their own line so the name isn't squeezed */}
        <p className="tabular mt-1.5 flex gap-3 text-[0.8125rem] text-muted sm:hidden">
          <span>
            <span className="font-semibold text-fg">{formatKm(a.distance_m)}</span> km
          </span>
          <span>
            <span className="font-semibold text-fg">{formatPaceFromSpeed(a.avg_speed_moving)}</span> /km
          </span>
          <span className="font-semibold text-fg">{formatDuration(a.moving_s)}</span>
        </p>
      </div>
      <div className="tabular hidden grid-cols-4 gap-6 text-right text-sm sm:grid">
        {[
          [formatKm(a.distance_m), "km"],
          [formatPaceFromSpeed(a.avg_speed_moving), "/km"],
          [formatDuration(a.moving_s), "moving"],
          [hr ?? "–", "bpm"],
        ].map(([v, u]) => (
          <div key={u}>
            <div className="font-semibold">{v}</div>
            <div className="text-[0.6875rem] text-muted">{u}</div>
          </div>
        ))}
      </div>
      <ChevronRight size={16} className="shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
