import Link from "next/link";
import type { ActivityListItem } from "@/lib/db/queries";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatKm, formatPaceFromSpeed } from "@/lib/units";
import { RouteThumb } from "./route-thumb";
import { Badge } from "./ui";

export function ActivityRow({ a, tz }: { a: ActivityListItem; tz?: string }) {
  const hr = a.avg_hr ? Math.round(a.avg_hr) : null;
  return (
    <Link href={`/activities/${a.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-3 transition-colors hover:bg-surface-2 sm:gap-4">
      <RouteThumb points={a.route_preview} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold">{a.name ?? "Run"}</p>
          {a.sport !== "running" && <Badge>{a.sport.replace(/_/g, " ")}</Badge>}
          {a.is_indoor && <Badge>Indoor</Badge>}
          {!a.usable_for_fitness && <Badge tone="warn">Data issues</Badge>}
        </div>
        <p className="text-xs text-muted">
          {formatDay(a.local_date)} · {localTime(a.start_time, a.utc_offset_s, tz)}
        </p>
        {/* phones: stats on their own line so the name isn't squeezed */}
        <p className="tabular mt-1 truncate text-sm text-muted sm:hidden">
          <span className="font-semibold text-fg">{formatKm(a.distance_m)}</span> km · <span className="font-semibold text-fg">{formatPaceFromSpeed(a.avg_speed_moving)}</span> /km
          {" · "}
          <span className="font-semibold text-fg">{formatDuration(a.moving_s)}</span>
        </p>
      </div>
      <div className="tabular hidden grid-cols-4 gap-5 text-right text-sm sm:grid">
        <div>
          <div className="font-semibold">{formatKm(a.distance_m)}</div>
          <div className="text-[10px] text-muted">km</div>
        </div>
        <div>
          <div className="font-semibold">{formatPaceFromSpeed(a.avg_speed_moving)}</div>
          <div className="text-[10px] text-muted">/km</div>
        </div>
        <div>
          <div className="font-semibold">{formatDuration(a.moving_s)}</div>
          <div className="text-[10px] text-muted">moving</div>
        </div>
        <div>
          <div className="font-semibold">{hr ?? "–"}</div>
          <div className="text-[10px] text-muted">bpm</div>
        </div>
      </div>
    </Link>
  );
}
