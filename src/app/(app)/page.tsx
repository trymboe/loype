import Link from "next/link";
import { ChevronRight, Watch } from "lucide-react";
import { RouteThumb } from "@/components/route-thumb";
import { SyncBanner } from "@/components/sync-banner";
import { NextWorkout } from "@/components/plan/next-workout";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
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
      <PageHeader
        eyebrow={formatDay(today, { weekday: "long", day: "numeric", month: "long" })}
        title="Today"
        action={
          connected && integration.last_success_at ? (
            <Link href="/more/integrations" className="mb-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg">
              <span className="size-1.5 rounded-full bg-good" />
              Synced {relativeTime(integration.last_success_at)}
            </Link>
          ) : undefined
        }
      />
      <SyncBanner integration={integration} />

      {!connected && acts.length === 0 ? (
        <EmptyState
          icon={<Watch size={22} />}
          title="Let's get your training history in"
          action={<ButtonLink href="/more/integrations">Connect Garmin</ButtonLink>}
        >
          Løype builds everything from your real runs. Connect your Garmin account with a Personal API key and import at least 3–6 months of history to establish
          a baseline.
        </EmptyState>
      ) : (
        <div className="stagger space-y-3">
          <NextWorkout today={today} />
          {latest ? (
            <Link href={`/activities/${latest.id}`} className="card block overflow-hidden">
              <div className="flex items-start justify-between gap-4 p-5 pb-0">
                <div className="min-w-0">
                  <p className="eyebrow">Latest run · {relativeDay(latest.local_date, today)}</p>
                  <p className="mt-1 truncate text-[1.375rem] leading-tight font-semibold tracking-[-0.02em]">{latest.name ?? "Run"}</p>
                  <p className="mt-0.5 text-[0.8125rem] text-muted">
                    {formatDay(latest.local_date)} · {localTime(latest.start_time, latest.utc_offset_s, tz)}
                  </p>
                </div>
                <RouteThumb points={latest.route_preview} size={68} />
              </div>
              <div className="mt-5 grid grid-cols-[1.05fr_1fr_1.3fr_0.8fr] border-t border-[var(--hairline)]">
                {[
                  { label: "Distance", value: formatKm(latest.distance_m, 1), unit: "km" },
                  { label: "Pace", value: formatPaceFromSpeed(latest.avg_speed_moving), unit: "/km" },
                  { label: "Time", value: formatDuration(latest.moving_s) },
                  { label: "Avg HR", value: latest.avg_hr ? Math.round(latest.avg_hr) : "–" },
                ].map((s, i) => (
                  <div key={s.label} className={i ? "border-l border-[var(--hairline)] px-3 py-4" : "py-4 pr-3 pl-5"}>
                    <Stat size="sm" label={s.label} value={s.value} unit={s.unit} />
                  </div>
                ))}
              </div>
            </Link>
          ) : (
            <EmptyState title="No runs in the last 8 weeks">Runs appear here after your next Garmin sync.</EmptyState>
          )}

          <Card>
            <CardHeader title="This week" aside={priorAvg > 0 ? `${formatKm(priorAvg, 1)} km avg` : "Mon–Sun"} />
            <div className="mt-4 flex items-end justify-between gap-4">
              <div>
                <span className="display text-[2.75rem]">{formatKm(current.distanceM, 1)}</span>
                <span className="ml-1 text-sm font-medium text-muted">km</span>
              </div>
              <div className="flex gap-5 pb-1 text-right">
                <Stat size="sm" label="Runs" value={current.runs} />
                <Stat size="sm" label="Time" value={formatDuration(current.movingS)} />
              </div>
            </div>
            {prior.length > 0 && priorAvg > 0 && (
              <div className="mt-4">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.max(weekPct, current.distanceM > 0 ? 2 : 0)}%` }} />
                </div>
                <p className="mt-2 text-xs text-muted">{Math.round(weekPct)}% of your 4-week average</p>
              </div>
            )}
            <div className="mt-5 grid grid-cols-7 gap-2">
              {days.map((d) => {
                const dist = dayDist.get(d) ?? 0;
                const isToday = d === today;
                const future = d > today;
                return (
                  <div key={d} className="flex flex-col items-center gap-2">
                    <div className="flex h-11 w-full items-end justify-center">
                      {dist ? (
                        <div
                          className="w-full max-w-7 rounded-[5px] bg-accent"
                          style={{ height: `${Math.max(18, (dist / maxDay) * 100)}%` }}
                          title={`${formatKm(dist, 1)} km`}
                        />
                      ) : (
                        <div className={future ? "size-1 rounded-full bg-surface-3" : "h-1 w-full max-w-7 rounded-full bg-surface-2"} title={future ? undefined : "Rest"} />
                      )}
                    </div>
                    <span
                      className={
                        isToday
                          ? "flex size-6 items-center justify-center rounded-full bg-fg text-[0.6875rem] font-semibold text-bg"
                          : "flex size-6 items-center justify-center text-[0.6875rem] font-medium text-muted"
                      }
                    >
                      {formatDay(d, { weekday: "narrow" })}
                    </span>
                    <span className="tabular -mt-1 h-3 text-[0.625rem] text-muted">{dist ? formatKm(dist, 0) : ""}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card href="/progress">
            <CardHeader
              title="Weekly volume"
              aside={
                <span className="inline-flex items-center gap-0.5 font-medium text-accent">
                  Progress <ChevronRight size={14} />
                </span>
              }
            />
            <p className="mt-0.5 text-xs text-muted">Last 8 weeks</p>
            <div className="mt-4 flex h-24 items-end gap-2">
              {weeks.map((w) => {
                const isCurrent = w.weekStart === thisWeek;
                return (
                  <div key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end" title={`Week of ${formatDay(w.weekStart, { day: "numeric", month: "short" })}: ${formatKm(w.distanceM, 1)} km`}>
                    <div className={isCurrent ? "w-full rounded-[5px] bg-accent" : "w-full rounded-[5px] bg-[var(--chart-bar)]"} style={{ height: `${Math.max(4, (w.distanceM / maxWeek) * 100)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-[0.6875rem] text-muted">
              <span>{formatDay(weeks[0].weekStart, { day: "numeric", month: "short" })}</span>
              <span>This week</span>
            </div>
          </Card>

        </div>
      )}
    </>
  );
}
