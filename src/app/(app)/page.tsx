import Link from "next/link";
import { ChevronRight, Watch } from "lucide-react";
import { RouteThumb } from "@/components/route-thumb";
import { SetupPrompt } from "@/components/setup-prompt";
import { SyncBanner } from "@/components/sync-banner";
import { SyncButton } from "@/components/sync/sync-button";
import { NextWorkout } from "@/components/plan/next-workout";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { FitnessSnapshotCard, InsightCard, RaceGoalCard } from "@/components/today/cards";
import { activitiesSince, getFitnessState, getIntegrationStatus, getStravaStatus } from "@/lib/db/queries";
import { createUserClient } from "@/lib/db/server";
import { loadProgressMotivation } from "@/lib/progress/service";
import { pickInsight } from "@/lib/progress/insight";
import { raceGoalFromRow } from "@/lib/race/goal";
import { raceStatus } from "@/lib/race/status";
import type { PlanWeek } from "@/lib/planning/types";
import { addDaysIso, formatDay, localTime, relativeDay, todayIn, weekStart } from "@/lib/dates";
import { isRun, weeklyVolume } from "@/lib/analytics/volume";
import { formatDuration, formatKm, formatPaceFromSpeed } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const tz = await userTimezone();
  const today = todayIn(tz);
  const thisWeek = weekStart(today);
  const from = addDaysIso(thisWeek, -7 * 7);
  const db = await createUserClient();
  const [acts, integration, strava, fitness, { data: plan }, { data: proposal }] = await Promise.all([
    activitiesSince(from),
    getIntegrationStatus(),
    getStravaStatus().catch(() => null),
    getFitnessState(),
    db.from("training_plans").select("id, weeks, goal:goals(*)").eq("status", "active").maybeSingle(),
    db.from("adaptation_proposals").select("title").eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const out = fitness?.output ?? null;
  const est = out?.estimate && !out.estimate.withheld ? out.estimate : null;
  const race = raceGoalFromRow((plan as { goal?: unknown } | null)?.goal);
  const status = race
    ? raceStatus({
        goal: { name: race.name, distanceM: race.distanceM, raceDate: race.raceDate ?? today, targetTimeS: race.targetTimeS },
        today,
        estimate: est ? { vdot: est.vdot, lower: est.lower, upper: est.upper, confidence: est.confidence } : null,
        longestRecentM: out?.longestRecentM ?? 0,
      })
    : null;
  const planWeeks = ((plan as { weeks?: PlanWeek[] } | null)?.weeks ?? []) as PlanWeek[];
  const wk = planWeeks.find((w) => w.start === weekStart(today));
  const motivation = acts.length ? await loadProgressMotivation(today, fitness) : null;
  const insight = motivation
    ? pickInsight({
        today,
        pendingProposal: proposal ?? null,
        milestones: motivation.milestones,
        payoff: motivation.payoff,
        load: out?.load?.length ? out.load[out.load.length - 1] : null,
        rampRate: out?.rampRate ?? null,
        race: race?.raceDate && status ? { name: race.name, daysToGo: status.daysToGo } : null,
      })
    : null;
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
  const connected = (integration && integration.status !== "not_configured") || (strava && strava.status !== "not_configured");
  const weekPct = priorAvg > 0 ? Math.min(100, (current.distanceM / priorAvg) * 100) : 0;

  return (
    <>
      <PageHeader
        eyebrow={formatDay(today, { weekday: "long", day: "numeric", month: "long" })}
        title="Today"
        action={connected ? <SyncButton className="mb-1" /> : undefined}
      />
      <SyncBanner integration={integration} strava={strava} />

      {!connected && acts.length === 0 ? (
        <EmptyState
          icon={<Watch size={22} />}
          title="Let's get your training history in"
          action={<ButtonLink href="/welcome">Set up Løype</ButtonLink>}
        >
          Løype builds everything from your real runs. Connect Garmin, or Strava for an Apple Watch, and import at least 3–6 months of history to establish
          a baseline.
        </EmptyState>
      ) : (
        <div className="stagger space-y-3">
          <SetupPrompt />
          <NextWorkout today={today} />
          {insight && <InsightCard insight={insight} />}
          {race && status && race.raceDate && <RaceGoalCard goal={race} status={status} week={wk ? { index: wk.index, total: planWeeks.length } : null} />}
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

          {out && <FitnessSnapshotCard out={out} />}

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
