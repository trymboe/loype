import Link from "next/link";
import { ChevronRight, RefreshCw } from "lucide-react";
import { RouteThumb } from "@/components/route-thumb";
import { SyncBanner } from "@/components/sync-banner";
import { NextWorkout } from "@/components/plan/next-workout";
import { ButtonLink, Card, EmptyState, Stat } from "@/components/ui";
import { activitiesSince, getIntegrationStatus } from "@/lib/db/queries";
import { addDaysIso, formatDay, localTime, relativeDay, relativeTime, todayIn, weekStart } from "@/lib/dates";
import { isRun, weeklyVolume } from "@/lib/analytics/volume";
import { formatDuration, formatKm, formatPaceFromSpeed } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const tz = await userTimezone();
  const today = todayIn(tz);
  const thisWeek = weekStart(today);
  const from = addDaysIso(thisWeek, -7 * 7);
  const [acts, integration] = await Promise.all([activitiesSince(from), getIntegrationStatus()]);
  const runs = acts.filter((a) => isRun(a.sport));
  const weeks = weeklyVolume(acts, from, today);
  const current = weeks[weeks.length - 1];
  const prior = weeks.slice(-5, -1);
  const priorAvg = prior.reduce((s, w) => s + w.distanceM, 0) / Math.max(1, prior.length);
  const latest = runs[runs.length - 1];
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(thisWeek, i));
  const dayDist = new Map<string, number>();
  for (const a of runs) if (a.local_date >= thisWeek) dayDist.set(a.local_date, (dayDist.get(a.local_date) ?? 0) + (a.distance_m ?? 0));
  const maxDay = Math.max(1, ...dayDist.values());
  const maxWeek = Math.max(1, ...weeks.map((w) => w.distanceM));
  const connected = integration && integration.status !== "not_configured";
  const weekPct = priorAvg > 0 ? Math.min(100, (current.distanceM / priorAvg) * 100) : 0;

  return (
    <>
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="label">{formatDay(today, { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 className="font-display text-4xl font-bold tracking-tight">Today</h1>
        </div>
        {connected && integration.last_success_at && (
          <Link href="/more/integrations" className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-muted hover:text-fg">
            <RefreshCw size={12} />
            Synced {relativeTime(integration.last_success_at)}
          </Link>
        )}
      </header>
      <SyncBanner integration={integration} />

      {!connected && acts.length === 0 ? (
        <EmptyState title="Let's get your training history in" action={<ButtonLink href="/more/integrations">Connect Garmin</ButtonLink>}>
          Løype builds everything from your real runs. Connect your Garmin account with a Personal API key and import at least 3–6 months of history to establish
          a baseline.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <NextWorkout today={today} />
          {latest ? (
            <Link href={`/activities/${latest.id}`} className="card rise block p-5 transition-colors hover:border-muted/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="label">Latest run · {relativeDay(latest.local_date, today)}</div>
                  <p className="mt-1 truncate font-display text-2xl font-semibold">{latest.name ?? "Run"}</p>
                  <p className="text-xs text-muted">
                    {formatDay(latest.local_date)} · {localTime(latest.start_time, latest.utc_offset_s, tz)}
                  </p>
                </div>
                <RouteThumb points={latest.route_preview} size={64} />
              </div>
              <div className="mt-4 grid grid-cols-[1fr_1fr_1.4fr_0.8fr] gap-3">
                <Stat size="md" label="Km" value={formatKm(latest.distance_m, 1)} />
                <Stat size="md" label="Pace" value={formatPaceFromSpeed(latest.avg_speed_moving)} />
                <Stat size="md" label="Time" value={formatDuration(latest.moving_s)} />
                <Stat size="md" label="HR" value={latest.avg_hr ? Math.round(latest.avg_hr) : "–"} />
              </div>
            </Link>
          ) : (
            <EmptyState title="No runs in the last 8 weeks">Runs appear here after your next Garmin sync.</EmptyState>
          )}

          <Card>
            <div className="flex items-end justify-between">
              <div className="label">This week</div>
              <span className="text-xs text-muted">Mon–Sun</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-4">
              <Stat label="Distance" value={formatKm(current.distanceM, 1)} unit="km" />
              <Stat label="Runs" value={current.runs} />
              <Stat label="Time" value={formatDuration(current.movingS)} />
            </div>
            {prior.length > 0 && priorAvg > 0 && (
              <div className="mt-4">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${weekPct}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {formatKm(current.distanceM, 1)} of your {formatKm(priorAvg, 1)} km 4-week average
                </p>
              </div>
            )}
            <div className="mt-5 grid grid-cols-7 items-end gap-2">
              {days.map((d) => {
                const dist = dayDist.get(d) ?? 0;
                const isToday = d === today;
                const future = d > today;
                return (
                  <div key={d} className="flex flex-col items-center gap-1.5">
                    <span className="tabular h-3 text-[10px] text-muted">{dist ? formatKm(dist, 0) : ""}</span>
                    <div className="flex h-14 w-full items-end">
                      <div
                        className={dist ? "w-full rounded-md bg-accent" : future ? "w-full rounded-md border border-dashed border-border" : "w-full rounded-md bg-surface-2"}
                        style={{ height: dist ? `${Math.max(12, (dist / maxDay) * 100)}%` : "6px" }}
                        title={dist ? `${formatKm(dist, 1)} km` : future ? undefined : "Rest"}
                      />
                    </div>
                    <span className={isToday ? "flex h-5 w-5 items-center justify-center rounded-full bg-fg text-[11px] font-bold text-bg" : "flex h-5 w-5 items-center justify-center text-[11px] text-muted"}>
                      {formatDay(d, { weekday: "narrow" })}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card href="/progress">
            <div className="flex items-end justify-between">
              <div className="label">Weekly volume · 8 weeks</div>
              <span className="text-xs font-semibold text-accent">Progress →</span>
            </div>
            <div className="mt-4 flex h-24 items-end gap-1.5">
              {weeks.map((w) => (
                <div key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end" title={`Week of ${formatDay(w.weekStart, { day: "numeric", month: "short" })}: ${formatKm(w.distanceM, 1)} km`}>
                  <div
                    className={w.weekStart === thisWeek ? "w-full rounded-md bg-accent" : "w-full rounded-md bg-accent/40"}
                    style={{ height: `${Math.max(3, (w.distanceM / maxWeek) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-muted">
              <span>{formatDay(weeks[0].weekStart, { day: "numeric", month: "short" })}</span>
              <span>This week</span>
            </div>
          </Card>

          <Link href="/plan" className="card flex items-center gap-3 p-4 text-sm transition-colors hover:border-muted/50">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">No training plan yet</p>
              <p className="text-xs text-muted">
                Plans and adaptive workouts come next. Løype is building your baseline from {runs.length} run{runs.length === 1 ? "" : "s"} in the last 8 weeks.
              </p>
            </div>
            <ChevronRight size={18} className="shrink-0 text-muted" />
          </Link>
        </div>
      )}
    </>
  );
}
