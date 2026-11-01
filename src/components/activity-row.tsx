import Link from "next/link";
import type { ActivityListItem } from "@/lib/db/queries";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatKm, formatPaceFromSpeed } from "@/lib/units";
import { RouteThumb } from "./route-thumb";
import { Badge } from "./ui";

export function ActivityRow({ a }: { a: ActivityListItem }) {
  return (
    <Link href={`/activities/${a.id}`} className="flex items-center gap-4 rounded-2xl px-2 py-3 transition-colors hover:bg-surface-2">
      <RouteThumb points={a.route_preview} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold">{a.name ?? "Run"}</p>
          {a.is_indoor && <Badge>Indoor</Badge>}
          {!a.usable_for_fitness && <Badge tone="warn">Data issues</Badge>}
        </div>
        <p className="text-xs text-muted">
          {formatDay(a.local_date)} · {localTime(a.start_time, a.utc_offset_s)}
        </p>
      </div>
      <div className="tabular grid grid-cols-3 gap-4 text-right text-sm">
        <div>
          <div className="font-semibold">{formatKm(a.distance_m)}</div>
          <div className="text-[10px] text-muted">km</div>
        </div>
        <div>
          <div className="font-semibold">{formatPaceFromSpeed(a.avg_speed_moving)}</div>
          <div className="text-[10px] text-muted">/km</div>
        </div>
        <div className="hidden sm:block">
          <div className="font-semibold">{formatDuration(a.moving_s)}</div>
          <div className="text-[10px] text-muted">moving</div>
        </div>
        <div className="sm:hidden">
          <div className="font-semibold">{a.avg_hr ? Math.round(a.avg_hr) : "–"}</div>
          <div className="text-[10px] text-muted">bpm</div>
        </div>
      </div>
    </Link>
  );
}
