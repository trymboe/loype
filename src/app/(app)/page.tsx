import Link from "next/link";
import { ActivityRow } from "@/components/activity-row";
import { SyncBanner } from "@/components/sync-banner";
import { ButtonLink, Card, EmptyState, Stat } from "@/components/ui";
import { activitiesSince, getIntegrationStatus } from "@/lib/db/queries";
import { addDaysIso, formatDay, todayIn, weekStart } from "@/lib/dates";
import { isRun, weeklyVolume } from "@/lib/analytics/volume";
import { userTimezone } from "@/lib/user-tz";
import { formatDuration, formatKm } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const tz = await userTimezone();
  const today = todayIn(tz);
  const thisWeek = weekStart(today);
  const from = addDaysIso(thisWeek, -7 * 7);
  const [acts, integration] = await Promise.all([activitiesSince(from), getIntegrationStatus()]);
  const weeks = weeklyVolume(acts, from, today);
  const current = weeks[weeks.length - 1];
  const prior = weeks.slice(-5, -1);
  const priorAvg = prior.reduce((s, w) => s + w.distanceM, 0) / Math.max(1, prior.length);
  const runs = acts.filter((a) => isRun(a.sport));
  const latest = runs[runs.length - 1];
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(thisWeek, i));
  const dayDist = new Map<string, number>();
  for (const a of runs) if (a.local_date >= thisWeek) dayDist.set(a.local_date, (dayDist.get(a.local_date) ?? 0) + (a.distance_m ?? 0));
  const maxDay = Math.max(1, ...dayDist.values());
  const maxWeek = Math.max(1, ...weeks.map((w) => w.distanceM));
  const connected = integration && integration.status !== "not_configured";

  return (
    <>
      <header className="mb-6">
        <p className="label">{formatDay(today, { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="font-display text-4xl font-bold tracking-tight">Today</h1>
      </header>
      <SyncBanner integration={integration} />

      {!connected && acts.length === 0 ? (
        <EmptyState title="Let's get your training history in" action={<ButtonLink href="/more/integrations">Connect Garmin</ButtonLink>}>
          Løype builds everything from your real runs. Connect your Garmin account with a Personal API key and import at least 3–6 months of history to establish
          a baseline.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="label">Today&apos;s workout</div>
            <p className="mt-2 font-display text-2xl font-semibold">No training plan yet</p>
            <p className="mt-1 text-sm text-muted">
              Plans, structured workouts and adaptive targets come with the plan builder, which isn&apos;t built yet. Your runs are being imported and analysed
              in the meantime.
            </p>
          </Card>

          <Card>
            <div className="flex items-end justify-between">
              <div className="label">This week</div>
              <span className="text-xs text-muted">Mon–Sun</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-4">
              <Stat label="Distance" value={formatKm(current.distanceM, 1)} unit="km" hint={prior.length ? `4-wk avg ${formatKm(priorAvg, 1)} km` : undefined} />
              <Stat label="Runs" value={current.runs} />
              <Stat label="Time" value={formatDuration(current.movingS)} />
            </div>
            <div className="mt-5 grid grid-cols-7 items-end gap-2">
              {days.map((d) => {
                const dist = dayDist.get(d) ?? 0;
                const isToday = d === today;
                return (
                  <div key={d} className="flex flex-col items-center gap-1.5">
                    <div className="flex h-16 w-full items-end">
                      <div
                        className={dist ? "w-full rounded-md bg-accent" : "w-full rounded-md bg-surface-2"}
                        style={{ height: dist ? `${Math.max(12, (dist / maxDay) * 100)}%` : "6px" }}
                        title={dist ? `${formatKm(dist, 1)} km` : "Rest"}
                      />
                    </div>
                    <span className={isToday ? "text-[11px] font-bold text-fg" : "text-[11px] text-muted"}>
                      {formatDay(d, { weekday: "narrow" })}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

          {latest && (
            <section>
              <div className="mb-1 flex items-baseline justify-between px-2">
                <h2 className="label">Latest run</h2>
                <Link href="/activities" className="text-xs font-semibold text-accent">
                  All activities
                </Link>
              </div>
              <div className="card px-2">
                <ActivityRow a={latest} tz={tz} />
              </div>
            </section>
          )}

          <Card href="/progress">
            <div className="flex items-end justify-between">
              <div className="label">Weekly volume · 8 weeks</div>
              <span className="text-xs font-semibold text-accent">Progress →</span>
            </div>
            <div className="mt-4 flex h-24 items-end gap-1.5">
              {weeks.map((w) => (
                <div key={w.weekStart} className="flex flex-1 flex-col items-center justify-end" title={`${formatKm(w.distanceM, 1)} km`}>
                  <div
                    className={w.weekStart === thisWeek ? "w-full rounded-md bg-accent" : "w-full rounded-md bg-accent/40"}
                    style={{ height: `${Math.max(3, (w.distanceM / maxWeek) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Calculated from imported runs. Weeks with no runs show as empty.</p>
          </Card>
        </div>
      )}
    </>
  );
}
