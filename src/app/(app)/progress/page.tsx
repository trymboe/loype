import { ButtonLink, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { VolumeChart } from "@/components/volume-chart";
import { weeklyVolume } from "@/lib/analytics/volume";
import { activitiesSince } from "@/lib/db/queries";
import { addDaysIso, todayIn } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";
import { formatKm } from "@/lib/units";

export const metadata = { title: "Progress" };
export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  const today = todayIn(await userTimezone());
  const acts = await activitiesSince(addDaysIso(today, -730));
  if (acts.length === 0) {
    return (
      <>
        <PageHeader title="Progress" />
        <EmptyState title="Nothing to chart yet" action={<ButtonLink href="/more/integrations">Import history</ButtonLink>}>
          Progress is built from your imported runs. Import at least a few months to see trends.
        </EmptyState>
      </>
    );
  }
  const weeks = weeklyVolume(acts, acts[0].local_date, today);
  const last4 = weeks.slice(-4);
  const prev4 = weeks.slice(-8, -4);
  const sum = (ws: typeof weeks, k: "distanceM" | "runs") => ws.reduce((s, w) => s + w[k], 0);
  // average over the weeks that exist: a 2-week history must not be divided by 4
  const kmNow = sum(last4, "distanceM") / Math.max(1, last4.length);
  const kmPrev = sum(prev4, "distanceM") / Math.max(1, prev4.length);
  const longest = Math.max(...last4.map((w) => w.longestM));
  const last12 = weeks.slice(-12);
  const weeksWithRuns = last12.filter((w) => w.runs > 0).length;

  return (
    <>
      <PageHeader title="Progress" subtitle="Training volume and consistency, calculated from your imported runs." />
      <div className="space-y-4">
        <Card>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat
              label="Avg weekly km"
              value={formatKm(kmNow, 1)}
              hint={prev4.length ? `${kmNow >= kmPrev ? "+" : "−"}${formatKm(Math.abs(kmNow - kmPrev), 1)} vs prior 4 wks` : "last 4 weeks"}
            />
            <Stat label="Runs / week" value={(sum(last4, "runs") / Math.max(1, last4.length)).toFixed(1)} hint={`last ${last4.length} weeks`} />
            <Stat label="Longest run" value={formatKm(longest, 1)} unit="km" hint="last 4 weeks" />
            <Stat label="Weeks with runs" value={`${weeksWithRuns}/${last12.length}`} hint={`last ${last12.length} weeks`} />
          </div>
        </Card>
        <Card>
          <div className="label mb-3">Weekly distance</div>
          <VolumeChart weeks={weeks} />
        </Card>
        <Card>
          <div className="label">Fitness estimates</div>
          <p className="mt-2 text-sm text-muted">
            Threshold pace, race predictions, VO2max estimates and aerobic-efficiency trends will appear here once the fitness model is built. They will only be
            shown when your data supports them, with their uncertainty.
          </p>
        </Card>
      </div>
    </>
  );
}
