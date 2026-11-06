import { CalendarRange, ChevronRight, LineChart } from "lucide-react";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { VolumeChart } from "@/components/volume-chart";
import { weeklyVolume } from "@/lib/analytics/volume";
import { ChartRangeProvider, ChartRangeSelector } from "@/components/progress/chart-range";
import { FitnessSection } from "@/components/fitness/fitness-section";
import { PayingOffCard } from "@/components/progress/paying-off";
import { MilestonesCard } from "@/components/progress/milestones";
import { loadProgressMotivation } from "@/lib/progress/service";
import { activitiesSince, getFitnessState, getVdotHistory } from "@/lib/db/queries";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { recomputeFitness } from "@/lib/fitness/service";
import { addDaysIso, todayIn } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";
import { formatKm } from "@/lib/units";

export const metadata = { title: "Progress" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ProgressPage() {
  const today = todayIn(await userTimezone());
  const acts = await activitiesSince(addDaysIso(today, -730));
  if (acts.length === 0) {
    return (
      <>
        <PageHeader title="Progress" />
        <EmptyState icon={<LineChart size={22} />} title="Nothing to chart yet" action={<ButtonLink href="/more/integrations">Import history</ButtonLink>} />
      </>
    );
  }
  const fitness = await ensureFitness(today);
  const vdotRows = fitness ? await getVdotHistory(fitness.model_version) : [];
  const motivation = await loadProgressMotivation(today, fitness, vdotRows);
  const history = vdotRows.map((r) => ({
    date: r.as_of,
    value: r.value,
    band: r.lower_bound != null && r.upper_bound != null ? ([r.lower_bound, r.upper_bound] as [number, number]) : null,
    confidence: r.confidence,
  }));
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
      <PageHeader title="Progress" />
      <ChartRangeProvider today={today}>
      <div className="stagger space-y-3">
        <PayingOffCard payoff={motivation.payoff} />
        <MilestonesCard milestones={motivation.milestones.slice(0, 6)} />
        <Card>
          <CardHeader title="Last 4 weeks" className="mb-4" />
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-4">
            <Stat
              label="Avg weekly km"
              value={formatKm(kmNow, 1)}
              unit="km"
              hint={
                prev4.length ? (
                  <span>
                    <span className={kmNow >= kmPrev ? "font-semibold text-good" : "font-semibold text-warn"}>
                      {kmNow >= kmPrev ? "↑" : "↓"} {formatKm(Math.abs(kmNow - kmPrev), 1)}
                    </span>{" "}
                    vs 4 wks before
                  </span>
                ) : undefined
              }
            />
            <Stat label="Runs / week" value={(sum(last4, "runs") / Math.max(1, last4.length)).toFixed(1)} />
            <Stat label="Longest run" value={formatKm(longest, 1)} unit="km" />
            <Stat label={`Weeks run, last ${last12.length}`} value={`${weeksWithRuns}/${last12.length}`} />
          </div>
        </Card>
        <Card href="/progress/weeks" className="flex items-center gap-3.5 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-accent/12 text-accent">
            <CalendarRange size={18} />
          </span>
          <p className="min-w-0 flex-1 text-[0.9375rem] font-semibold">Weekly recaps</p>
          <ChevronRight size={18} className="shrink-0 text-subtle" />
        </Card>
        <ChartRangeSelector />
        <Card>
          <h2 className="section-title mb-4">Weekly distance</h2>
          <VolumeChart weeks={weeks} />
        </Card>
        {fitness ? (
          <FitnessSection out={fitness.output} history={history} computedAt={fitness.computed_at} />
        ) : (
          <Card>
            <h2 className="section-title">Fitness estimates</h2>
            <p className="mt-2 text-sm text-muted">Not calculated yet.</p>
          </Card>
        )}
      </div>
      </ChartRangeProvider>
    </>
  );
}

/** Recompute when the cached model is from an earlier day or older than the newest activity. No-op if inputs are unchanged. */
async function ensureFitness(today: string) {
  const state = await getFitnessState();
  const user = await getSessionUser();
  if (!user) return state;
  const db = createAdminClient();
  const { data: newest } = await db.from("activities").select("updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const stale = !state || state.as_of !== today || (newest && newest.updated_at > state.computed_at);
  if (!stale) return state;
  try {
    await recomputeFitness(db, user.id, today, Date.now() + 25_000);
  } catch (e) {
    console.error("fitness recompute failed", e);
    return state;
  }
  return getFitnessState();
}
