import { LineChart } from "lucide-react";
import { ButtonLink, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { VolumeChart } from "@/components/volume-chart";
import { weeklyVolume } from "@/lib/analytics/volume";
import { ChartRangeProvider, ChartRangeSelector } from "@/components/progress/chart-range";
import { FitnessSection } from "@/components/fitness/fitness-section";
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
        <EmptyState icon={<LineChart size={22} />} title="Nothing to chart yet" action={<ButtonLink href="/more/integrations">Import history</ButtonLink>}>
          Progress is built from your imported runs. Import at least a few months to see trends.
        </EmptyState>
      </>
    );
  }
  const fitness = await ensureFitness(today);
  const vdotRows = fitness ? await getVdotHistory(fitness.model_version) : [];
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
      <PageHeader title="Progress" subtitle="Training volume and consistency, calculated from your imported runs." />
      <ChartRangeProvider today={today}>
      <div className="stagger space-y-3">
        <Card>
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
                    vs prior 4 wks
                  </span>
                ) : (
                  "last 4 weeks"
                )
              }
            />
            <Stat label="Runs / week" value={(sum(last4, "runs") / Math.max(1, last4.length)).toFixed(1)} hint={`last ${last4.length} weeks`} />
            <Stat label="Longest run" value={formatKm(longest, 1)} unit="km" hint="last 4 weeks" />
            <Stat label="Weeks with runs" value={`${weeksWithRuns}/${last12.length}`} hint={`last ${last12.length} weeks`} />
          </div>
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
            <p className="mt-2 text-sm text-muted">Your fitness model has not been computed yet. It runs after each sync; reload in a minute.</p>
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
