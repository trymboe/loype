import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, Flag, Mountain, Trash2 } from "lucide-react";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { Provenance } from "@/components/fitness/fitness-section";
import { CourseUpload } from "@/components/race/course-upload";
import { CourseView } from "@/components/race/course-view";
import { PredictionBar } from "@/components/race/prediction-bar";
import { removeCourseAction } from "./actions";
import { createAdminClient, createUserClient, getSessionUser } from "@/lib/db/server";
import { getFitnessState } from "@/lib/db/queries";
import { activePlan } from "@/lib/planning/service";
import { PHASE_LABEL, type PlanWeek } from "@/lib/planning/types";
import { raceGoalFromRow } from "@/lib/race/goal";
import { pacingPlan, type Strategy } from "@/lib/race/pacing";
import { raceStatus, type ProjectionInput } from "@/lib/race/status";
import { livePlanProjection } from "@/lib/race/projection";
import type { CoursePoint } from "@/lib/race/gpx";
import { fmtDist, fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatDay, todayIn, weekStart } from "@/lib/dates";
import { formatKm, formatPace } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const metadata = { title: "Race" };
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function RacePage({ searchParams }: { searchParams: Promise<{ strategy?: string; for?: string }> }) {
  const user = await getSessionUser();
  if (!user) return null;
  const sp = await searchParams;
  const today = todayIn(await userTimezone());
  const plan = await activePlan(createAdminClient(), user.id);
  const goal = raceGoalFromRow(plan?.goal);
  if (!plan || !goal) {
    return (
      <>
        <PageHeader title="Race" back={{ href: "/plan", label: "Plan" }} />
        <EmptyState icon={<Flag size={22} />} title="No race on the calendar" action={<ButtonLink href="/plan/new">Set a race goal</ButtonLink>}>
          Pick a race distance and date, and this page counts down, compares your predicted time with your target and builds a race-day pacing plan.
        </EmptyState>
      </>
    );
  }

  const db = await createUserClient();
  const [fitness, { data: course }, { data: keyRows }, { data: allWorkouts }] = await Promise.all([
    getFitnessState(),
    db.from("race_courses").select("name, file_name, distance_m, gain_m, loss_m, min_ele_m, max_ele_m, points").eq("goal_id", goal.id).maybeSingle(),
    db
      .from("planned_workouts")
      .select("id, date, title, type, duration_s, status")
      .eq("plan_id", plan.id)
      .eq("key", true)
      .eq("status", "planned")
      .gte("date", today)
      .lte("date", goal.raceDate ?? "9999-12-31")
      .neq("type", "race")
      .order("date")
      .limit(4),
    db.from("planned_workouts").select("date, status, type").eq("plan_id", plan.id),
  ]);
  const out = fitness?.output;
  const est = out?.estimate && !out.estimate.withheld ? out.estimate : null;
  const projection: ProjectionInput | null = livePlanProjection(plan, out, (allWorkouts ?? []) as any[], today);
  // without a race date the status is computed "as of today" and the countdown is hidden
  const s = raceStatus({
    goal: { name: goal.name, distanceM: goal.distanceM, raceDate: goal.raceDate ?? today, targetTimeS: goal.targetTimeS },
    today,
    estimate: est ? { vdot: est.vdot, lower: est.lower, upper: est.upper, confidence: est.confidence } : null,
    longestRecentM: out?.longestRecentM ?? 0,
    projection,
  });
  const status = goal.raceDate ? s : null;
  const weeks = (plan.weeks ?? []) as PlanWeek[];
  const thisWeek = weeks.find((w) => w.start === weekStart(today));

  // pacing: target, prediction or plan projection
  const strategy: Strategy = sp.strategy === "even" ? "even" : "negative";
  const options = [
    goal.targetTimeS ? { key: "target", label: "Target", timeS: goal.targetTimeS } : null,
    s.prediction ? { key: "predicted", label: "Predicted now", timeS: s.prediction.timeS } : null,
    projection ? { key: "projected", label: "If you follow the plan", timeS: projection.projectedS } : null,
  ].filter((o): o is { key: string; label: string; timeS: number } => o != null);
  const chosen = options.find((o) => o.key === sp.for) ?? options[0] ?? null;
  const coursePoints = (course?.points ?? null) as CoursePoint[] | null;
  const pacing = chosen ? pacingPlan({ distanceM: goal.distanceM, targetS: chosen.timeS, strategy, course: coursePoints }) : null;
  const href = (p: { strategy?: string; for?: string }) => {
    const q = new URLSearchParams();
    const st = p.strategy ?? strategy;
    const fr = p.for ?? chosen?.key;
    if (st !== "negative") q.set("strategy", st);
    if (fr && fr !== options[0]?.key) q.set("for", fr);
    const qs = q.toString();
    return `/plan/race${qs ? `?${qs}` : ""}#pacing`;
  };
  const courseOff = course && Math.abs(course.distance_m - goal.distanceM) / goal.distanceM > 0.03;

  return (
    <>
      <PageHeader eyebrow={`${fmtDist(goal.distanceM)}${goal.raceDate ? ` · ${formatDay(goal.raceDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}` : ""}`} title={goal.name} back={{ href: "/plan", label: "Plan" }} />
      <div className="stagger space-y-3">
        {status && (
          <Card className="relative overflow-hidden">
            <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
            {status.past ? (
              <>
                <p className="section-title">{status.headline}</p>
                <p className="mt-1 text-sm text-muted">{status.detail}</p>
                <div className="mt-4">
                  <ButtonLink href="/plan/new">Set your next goal</ButtonLink>
                </div>
              </>
            ) : (
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="label">{status.daysToGo === 0 ? "It's race day" : "Race day in"}</p>
                  {status.daysToGo > 0 && (
                    <p className="mt-1">
                      <span className="display text-[3.5rem] leading-none">{status.daysToGo}</span>
                      <span className="ml-1.5 text-base font-medium text-muted">day{status.daysToGo === 1 ? "" : "s"}</span>
                    </p>
                  )}
                  {status.daysToGo >= 14 && (
                    <p className="mt-1.5 text-xs text-muted">
                      {status.weeksToGo} weeks{status.daysToGo % 7 ? ` and ${status.daysToGo % 7} day${status.daysToGo % 7 === 1 ? "" : "s"}` : ""}
                    </p>
                  )}
                </div>
                {thisWeek && (
                  <div className="pb-1 text-right">
                    <p className="label">This week</p>
                    <p className="mt-1 text-[0.9375rem] font-semibold">{PHASE_LABEL[thisWeek.phase]}</p>
                    <p className="text-xs text-muted">
                      Week {thisWeek.index + 1} of {weeks.length}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="section-title">Prediction vs target</h2>
            {s.prediction && <Provenance confidence={s.prediction.confidence} />}
          </div>
          <p className="mt-3 text-[1.0625rem] leading-snug font-semibold tracking-[-0.01em]">{s.past ? "Your last prediction" : s.headline}</p>
          {!s.past && <p className="mt-1 text-sm leading-relaxed text-muted">{s.detail}</p>}
          <div className="mt-5 grid grid-cols-3 gap-4">
            <Stat size="md" label="Predicted now" value={s.prediction ? fmtTime(s.prediction.timeS) : "–"} hint={s.prediction ? `${formatPace(s.prediction.timeS / (goal.distanceM / 1000))}/km` : undefined} />
            <Stat
              size="md"
              label="Target"
              value={goal.targetTimeS ? fmtTime(goal.targetTimeS) : "–"}
              hint={goal.targetTimeS ? `${formatPace(goal.targetTimeS / (goal.distanceM / 1000))}/km` : <Link href="/plan/new" className="text-accent">Add one</Link>}
            />
            <Stat
              size="md"
              label={s.gapS == null ? "Gap" : s.gapS > 0 ? "To find" : "Spare"}
              value={s.gapS == null ? "–" : fmtTime(Math.abs(s.gapS))}
              hint={s.gapS != null ? `${formatPace(Math.abs(s.gapS) / (goal.distanceM / 1000))}/km` : undefined}
            />
          </div>
          {s.prediction && <PredictionBar prediction={s.prediction} target={goal.targetTimeS} projection={projection} />}
          <details className="mt-4 text-xs text-muted">
            <summary className="cursor-pointer font-medium text-accent">How this is calculated</summary>
            <p className="mt-2 leading-relaxed">
              The prediction applies the Daniels VDOT formula to your current fitness estimate
              {est ? ` (${est.vdot.toFixed(1)}, likely ${est.lower.toFixed(1)}–${est.upper.toFixed(1)})` : ""}. The band is that likely range.
              {s.prediction && s.prediction.endurancePct > 0
                ? ` It is slowed ${s.prediction.endurancePct} % because the race is much longer than your longest recent run (${fmtDist(out?.longestRecentM ?? 0)}); longer long runs remove that.`
                : ""}
              {s.vdotForTarget ? ` Your target corresponds to VDOT ${s.vdotForTarget}.` : ""}
              {projection ? " The plan projection adds typical gains for the training weeks left, scaled by how many recent sessions you completed." : ""} These are estimates; a race or time trial gives the real answer.
            </p>
          </details>
        </Card>

        {(keyRows ?? []).length > 0 && !s.past && (
          <Card>
            <CardHeader title="Key sessions before race day" aside={<Link href="/plan" className="font-medium text-accent">Plan</Link>} />
            <ul className="divide-hairline mt-2">
              {(keyRows ?? []).map((w: any) => (
                <li key={w.id}>
                  <Link href={`/plan/workouts/${w.id}`} className="-mx-1 flex items-center gap-3 rounded-xl px-1 py-2.5 hover:bg-surface-2/50">
                    <span className={clsx("w-16 shrink-0 text-xs", w.date === today ? "font-semibold text-accent" : "text-muted")}>{formatDay(w.date, { weekday: "short", day: "numeric", month: "short" })}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{w.title}</span>
                    <span className="tabular text-xs text-muted">{Math.round(w.duration_s / 60)} min</span>
                    <ChevronRight size={14} className="text-subtle" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <div id="pacing" className="flex flex-wrap items-baseline justify-between gap-2 scroll-mt-4">
            <h2 className="section-title">Race-day pacing</h2>
            <Badge>Calculated{pacing?.usesCourse ? " · course-adjusted" : ""}</Badge>
          </div>
          {!pacing ? (
            <p className="mt-2 text-sm text-muted">Needs a target time or a fitness estimate.</p>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                <div className="seg" role="group" aria-label="Finish time">
                  {options.map((o) => (
                    <Link key={o.key} href={href({ for: o.key })} aria-pressed={o.key === chosen!.key} role="button" scroll={false}>
                      {o.label}
                    </Link>
                  ))}
                </div>
                <div className="seg" role="group" aria-label="Strategy">
                  <Link href={href({ strategy: "negative" })} aria-pressed={strategy === "negative"} role="button" scroll={false}>
                    Negative split
                  </Link>
                  <Link href={href({ strategy: "even" })} aria-pressed={strategy === "even"} role="button" scroll={false}>
                    Even effort
                  </Link>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-4">
                <Stat size="md" label="Finish" value={fmtTime(pacing.targetS)} />
                <Stat size="md" label="Average pace" value={formatPace(pacing.averagePaceSPerKm)} unit="/km" />
                <Stat size="md" label="Halves" value={`${fmtTime(pacing.firstHalfS)}`} hint={`then ${fmtTime(pacing.secondHalfS)}`} />
              </div>
              {pacing.checkpoints.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                  {pacing.checkpoints.map((c) => (
                    <span key={c.label}>
                      {c.label} <span className="tabular font-semibold text-fg">{fmtTime(c.timeS)}</span>
                    </span>
                  ))}
                </div>
              )}
              <table className="tabular mt-4 w-full text-sm">
                <thead className="text-left text-[0.6875rem] text-muted">
                  <tr>
                    <th className="py-1.5 font-medium">Km</th>
                    <th className="py-1.5 text-right font-medium">Pace</th>
                    <th className="py-1.5 text-right font-medium">Split</th>
                    <th className="py-1.5 text-right font-medium">Elapsed</th>
                    {pacing.usesCourse && <th className="py-1.5 text-right font-medium">Grade</th>}
                  </tr>
                </thead>
                <tbody>
                  {pacing.splits.map((sp) => {
                    const partial = sp.endM - sp.startM < 999;
                    return (
                      <tr key={sp.index} className="border-t border-[var(--hairline)]">
                        <td className="py-2 text-muted">{partial ? formatKm(sp.endM, 2) : sp.index}</td>
                        <td className="py-2 text-right font-semibold">{formatPace(sp.paceSPerKm)}</td>
                        <td className="py-2 text-right">{fmtTime(sp.splitS)}</td>
                        <td className="py-2 text-right text-muted">{fmtTime(sp.cumS)}</td>
                        {pacing.usesCourse && (
                          <td className={clsx("py-2 text-right text-xs", (sp.gradePct ?? 0) >= 1.5 ? "text-warn" : (sp.gradePct ?? 0) <= -1.5 ? "text-good" : "text-muted")}>
                            {sp.gradePct == null ? "–" : `${sp.gradePct > 0 ? "+" : ""}${sp.gradePct.toFixed(1)} %`}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                {strategy === "negative"
                  ? "Starts about 1 % easier and finishes about 1 % harder than even effort: the surest way to avoid fading. "
                  : "The same effort all the way. "}
                {pacing.usesCourse
                  ? `Paces follow the course: climbs cost about ${(3.3).toFixed(1)} % per 1 % of grade and descents give back about half that. Equal-effort flat pace ${formatPace(pacing.flatPaceSPerKm)}/km.`
                  : "Upload the course GPX to adjust each kilometre for hills."}
              </p>
            </>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="section-title">Course</h2>
            {course && (
              <form action={removeCourseAction}>
                <button type="submit" className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-danger">
                  <Trash2 size={13} /> Remove
                </button>
              </form>
            )}
          </div>
          {course ? (
            <>
              <p className="mt-0.5 truncate text-xs text-muted">{course.name ?? course.file_name}</p>
              <div className="mt-4 grid grid-cols-3 gap-4">
                <Stat size="sm" label="Distance" value={formatKm(course.distance_m, 2)} unit="km" />
                <Stat size="sm" label="Climb" value={course.gain_m != null ? Math.round(course.gain_m) : "–"} unit="m" />
                <Stat size="sm" label="Descent" value={course.loss_m != null ? Math.round(course.loss_m) : "–"} unit="m" />
              </div>
              {courseOff && (
                <p className="mt-3 rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
                  The GPX is {formatKm(course.distance_m, 2)} km and the race is {formatKm(goal.distanceM, 2)} km. The pacing plan stretches the course profile to the race distance.
                </p>
              )}
              <div className="mt-4">
                <CourseView points={coursePoints!} />
              </div>
              <div className="mt-4">
                <CourseUpload replacing />
              </div>
            </>
          ) : (
            <div className="mt-3 flex flex-col items-start gap-3">
              <p className="flex items-start gap-2 text-sm leading-relaxed text-muted">
                <Mountain size={18} className="mt-0.5 shrink-0" />
                Add the course from the race website or a route planner to see the map, the elevation profile and hill-adjusted splits.
              </p>
              <CourseUpload />
            </div>
          )}
        </Card>
        {!goal.raceDate && (
          <p className="px-1 text-xs text-muted">
            No race date set. <Link href="/plan/new" className="text-accent">Add one</Link> to get a countdown.
          </p>
        )}
      </div>
    </>
  );
}
