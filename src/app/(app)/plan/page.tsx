import Link from "@/components/link";
import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, Flag, History, Lock, Minus, Target, X } from "lucide-react";
import { Badge, Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { ProposalCard, type ProposalRow } from "@/components/plan/proposal-card";
import { PlanForm } from "./plan-form";
import { AddTimeTrial } from "./add-time-trial";
import { ProjectionCard } from "@/components/plan/projection-card";
import { PlanMonth } from "@/components/plan/plan-month";
import { adherence, liveProjection, type Projection } from "@/lib/planning/projection";
import { BaselineCard, defaultsFor } from "@/components/plan/plan-start";
import { addDaysIso, daysBetween, formatDay, todayIn, weekStart } from "@/lib/dates";
import { createAdminClient, createUserClient, getSessionUser } from "@/lib/db/server";
import { activePlan, loadBaseline, runPlanMaintenance } from "@/lib/planning/service";
import { goalDistance, predictedPace } from "@/lib/planning/generator";
import { GOAL_LABEL, PHASE_LABEL, isHard, type Baseline, type Phase, type PlanWeek } from "@/lib/planning/types";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatPace } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const metadata = { title: "Plan" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view === "month" ? "month" : "list";
  const user = await getSessionUser();
  if (!user) return null;
  const today = todayIn(await userTimezone());
  const admin = createAdminClient();
  try {
    await runPlanMaintenance(admin, user.id, today);
  } catch {
    // the page still shows the plan; the next sync retries
  }
  const plan = await activePlan(admin, user.id);
  if (!plan) return <NoPlan userId={user.id} today={today} />;

  const db = await createUserClient();
  const [{ data: workouts }, { data: proposals }, { data: acts }] = await Promise.all([
    db.from("planned_workouts").select("id, date, type, title, duration_s, distance_m, key, locked, status, activity_id, execution").eq("plan_id", plan.id).order("date"),
    db
      .from("adaptation_proposals")
      .select("id, rule, title, explanation, evidence, changes, status, decided_at")
      .eq("plan_id", plan.id)
      .or(`status.eq.pending,and(status.in.(accepted,rejected),decided_at.gte.${addDaysIso(today, -14)})`)
      .order("created_at", { ascending: false }),
    db.from("activities").select("local_date, moving_s").eq("sport", "running").is("duplicate_of", null).gte("local_date", (plan.weeks as PlanWeek[])[0]?.start ?? today),
  ]);
  const ws = (workouts ?? []) as any[];
  const goal = plan.goal;
  const baseline = plan.baseline as Baseline;
  const d = goalDistance({ kind: goal.kind, name: goal.name, distanceM: goal.distance_m, raceDate: goal.race_date, targetTimeS: goal.target_time_s, targetWeeklyKm: goal.target_weekly_km });
  const pred = d ? predictedPace(baseline, d) : null;
  const weeks = plan.weeks as PlanWeek[];
  const thisWeek = weekStart(today);
  const ranBy = new Map<string, number>();
  for (const a of acts ?? []) ranBy.set(weekStart(a.local_date), (ranBy.get(weekStart(a.local_date)) ?? 0) + (a.moving_s ?? 0) / 60);
  const title = goal.kind === "race" && goal.name ? goal.name : GOAL_LABEL[goal.kind as keyof typeof GOAL_LABEL];
  const pending = (proposals ?? []).filter((p: any) => p.status === "pending");
  const applied = (proposals ?? []).filter((p: any) => p.status === "accepted");
  // declined lately and still relevant: can be applied after all (a mis-tap, or a change of mind)
  const declined = (proposals ?? []).filter(
    (p: any) =>
      p.status === "rejected" &&
      !pending.some((q: any) => q.rule === p.rule) &&
      (p.rule === "A" || (p.changes as { date: string }[]).some((c) => c.date >= today)),
  );
  const todays = ws.filter((w) => w.date === today && w.type !== "rest");
  const hasTimeTrial = ws.some((w) => w.type === "time_trial" && (w.status === "completed" || (w.status === "planned" && w.date >= today)));

  // projection: as stored at plan start, and re-projected from today's fitness
  const startProj = ((plan.config as { projection?: Projection | null } | null)?.projection ?? null) as Projection | null;
  let liveProj: Projection | null = null;
  if (startProj) {
    const { data: fs } = await db.from("fitness_state").select("output").maybeSingle();
    const est = fs?.output?.estimate;
    if (est && !est.withheld) {
      const remainingWeeks = weeks.filter((w) => w.start >= thisWeek && w.phase !== "taper" && w.phase !== "race").length;
      liveProj = liveProjection(startProj, {
        vdot: est.vdot,
        remainingWeeks,
        adherence: adherence(ws, today, addDaysIso(today, -28)),
        currentLongestM: fs.output.longestRecentM ?? 0,
        asOf: today,
      });
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={title}
        title="Plan"
        action={
          <div className="mb-1 flex gap-1.5">
            <Link href="/plan/history" className="chip" aria-label="Plan history">
              <History size={14} /> History
            </Link>
            <Link href="/plan/goal" className="chip" aria-label="Goal">
              <Target size={14} /> Goal
            </Link>
          </div>
        }
      />
      <div className="stagger space-y-3">
        {pending.map((p: any) => (
          <ProposalCard key={p.id} p={p as ProposalRow} />
        ))}
        {declined.map((p: any) => (
          <ProposalCard key={p.id} p={p as ProposalRow} />
        ))}

        {startProj && <ProjectionCard start={startProj} live={liveProj} target={goal.target_time_s ?? null} />}

        <Card>
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-4">
            {goal.race_date ? (
              <Stat label="Race day" value={daysBetween(today, goal.race_date)} unit="days" hint={formatDay(goal.race_date)} />
            ) : (
              <Stat label="Plan ends" value={formatDay(addDaysIso(weeks.at(-1)!.start, 6))} size="md" hint={`${weeks.length} weeks`} />
            )}
            {d && pred && <Stat label="Predicted now" value={fmtTime((pred * d) / 1000)} size="md" hint={`${formatPace(pred)}/km`} />}
            {goal.target_time_s && <Stat label="Target" value={fmtTime(goal.target_time_s)} size="md" hint={d ? `${formatPace(goal.target_time_s / (d / 1000))}/km` : undefined} />}
            {plan.race_pace && <Stat label="Training race pace" value={formatPace(plan.race_pace)} unit="/km" size="md" />}
          </div>
          {d && (
            <Link href="/plan/race" className="-mx-1 mt-5 flex items-center gap-2 rounded-xl px-1 py-1 text-sm font-medium hover:bg-surface-2/50">
              <Flag size={15} className="text-accent" />
              <span className="flex-1">Race plan and pacing</span>
              <ChevronRight size={16} className="text-subtle" />
            </Link>
          )}
          {(plan.warnings as string[]).length > 0 && (
            <ul className="mt-3 space-y-1">
              {(plan.warnings as string[]).map((w, i) => (
                <li key={i} className="rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {todays.length > 0 && (
          <Card>
            <CardHeader title="Today" className="mb-1" />
            {todays.map((w) => (
              <WorkoutRow key={w.id} w={w} today={today} big />
            ))}
          </Card>
        )}

        <PhaseBar weeks={weeks} current={thisWeek} />

        <div className="flex items-start gap-1.5 px-1">
          <div className="flex gap-1.5" aria-label="Plan view">
            {(["list", "month"] as const).map((v) => (
              <Link key={v} href={v === "list" ? "/plan" : "/plan?view=month"} aria-pressed={view === v} className="chip" scroll={false}>
                {v === "list" ? "Weeks" : "Month"}
              </Link>
            ))}
          </div>
          {!hasTimeTrial && <AddTimeTrial planId={plan.id} />}
        </div>

        {view === "month" && <PlanMonth workouts={ws} today={today} first={weeks[0].start} last={addDaysIso(weeks.at(-1)!.start, 6)} />}

        {view === "list" && weeks.map((wk) => {
          const end = addDaysIso(wk.start, 6);
          const items = ws.filter((w) => w.date >= wk.start && w.date <= end);
          const isCurrent = wk.start === thisWeek;
          const past = end < today;
          const planned = items.filter((w) => w.status !== "skipped").reduce((a, w) => a + w.duration_s / 60, 0);
          const ran = ranBy.get(wk.start) ?? 0;
          return (
            <details
              key={wk.start}
              open={isCurrent || (wk.start > thisWeek && wk.start <= addDaysIso(thisWeek, 7))}
              className={clsx("card group/week relative overflow-hidden px-4 py-3.5", past && !isCurrent && "opacity-75")}
            >
              {isCurrent && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />}
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[0.9375rem] font-semibold whitespace-nowrap">
                    Week {wk.index + 1}
                    <span className="font-normal text-muted">{formatDay(wk.start, { day: "numeric", month: "short" })}</span>
                    {isCurrent && <Badge tone="accent">This week</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">{wk.note || PHASE_LABEL[wk.phase]}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5 text-right">
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={PHASE_LABEL[wk.phase]}>
                    <span className="size-2 rounded-full" style={{ background: PHASE_COLOR[wk.phase] }} />
                    <span className="hidden sm:inline">{PHASE_LABEL[wk.phase]}</span>
                  </span>
                  <div className="tabular w-[4.5rem] text-xs">
                    {past || isCurrent ? <span className="font-semibold text-fg">{Math.round(ran)}</span> : null}
                    <span className="text-muted">
                      {past || isCurrent ? " / " : ""}
                      {Math.round(planned)} min
                    </span>
                  </div>
                  <ChevronDown size={16} className="text-subtle transition-transform group-open/week:rotate-180" />
                </div>
              </summary>
              <ul className="divide-hairline mt-3 border-t border-[var(--hairline)]">
                {items.map((w) => (
                  <li key={w.id}>
                    <WorkoutRow w={w} today={today} />
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
        {applied.length > 0 && (
          <div className="space-y-3">
            <h2 className="section-title px-1 pt-3">Recently applied</h2>
            {applied.map((p: any) => (
              <ProposalCard key={p.id} p={p as ProposalRow} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function StatusIcon({ status, past }: { status: string; past: boolean }) {
  if (status === "completed")
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-good text-bg">
        <Check size={12} strokeWidth={3} />
      </span>
    );
  if (status === "missed")
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-danger/15 text-danger">
        <X size={12} strokeWidth={3} />
      </span>
    );
  if (status === "skipped")
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Minus size={12} strokeWidth={3} />
      </span>
    );
  return <span className={clsx("block size-5 rounded-full border-2", past ? "border-subtle" : "border-surface-3")} />;
}

function WorkoutRow({ w, today, big }: { w: any; today: string; big?: boolean }) {
  const hard = isHard(w.type);
  return (
    <Link href={`/plan/workouts/${w.id}`} className={clsx("-mx-1 flex items-center gap-3 rounded-xl px-1 transition-colors hover:bg-surface-2/50", big ? "py-3" : "py-2.5")}>
      <div className={clsx("w-9 shrink-0 text-xs", w.date === today ? "font-semibold text-accent" : "text-muted")}>{formatDay(w.date, { weekday: "short" })}</div>
      <div className="flex w-5 justify-center">
        <StatusIcon status={w.status} past={w.date < today} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={clsx("truncate", big ? "text-lg font-semibold tracking-[-0.01em]" : "text-sm font-medium", w.status === "skipped" && "text-muted line-through")}>
          {w.title}
          {w.locked && <Lock size={12} className="ml-1 inline text-muted" />}
        </div>
        {w.execution?.verdict && w.execution.verdict !== "as_planned" && <div className="mt-0.5 truncate text-xs text-muted">{w.execution.notes?.[0]}</div>}
      </div>
      <div className="flex items-center gap-1.5">
        {hard && <span className="size-1.5 rounded-full bg-intervals" title="Hard session" />}
        <span className="tabular text-xs text-muted">{Math.round(w.duration_s / 60)} min</span>
        <ChevronRight size={14} className="text-subtle" />
      </div>
    </Link>
  );
}

const PHASE_COLOR: Record<Phase, string> = {
  base: "color-mix(in srgb, var(--accent) 35%, var(--surface-3))",
  build: "color-mix(in srgb, var(--accent) 65%, var(--surface-3))",
  specific: "var(--accent)",
  recovery: "var(--surface-3)",
  taper: "var(--tempo)",
  race: "var(--intervals)",
};

function PhaseBar({ weeks, current }: { weeks: PlanWeek[]; current: string }) {
  const max = Math.max(...weeks.map((w) => w.targetMinutes), 1);
  return (
    <Card>
      <CardHeader title="Phases and weekly time" className="mb-4" />
      <div className="flex h-24 items-end gap-[3px]">
        {weeks.map((w) => (
          <div key={w.start} className="flex h-full flex-1 flex-col items-center justify-end" title={`Week ${w.index + 1}: ${PHASE_LABEL[w.phase]}, ${w.targetMinutes} min`}>
            <div
              className={clsx("w-full rounded-[3px]", w.start === current && "ring-2 ring-fg ring-offset-2 ring-offset-[var(--surface)]")}
              style={{ height: `${Math.max(6, (w.targetMinutes / max) * 100)}%`, background: PHASE_COLOR[w.phase] }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[0.6875rem] text-muted">
        {(["base", "build", "specific", "recovery", "taper", "race"] as Phase[])
          .filter((p) => weeks.some((w) => w.phase === p))
          .map((p) => (
            <span key={p} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-[2px]" style={{ background: PHASE_COLOR[p] }} />
              {PHASE_LABEL[p]}
            </span>
          ))}
      </div>
    </Card>
  );
}

async function NoPlan({ userId, today }: { userId: string; today: string }) {
  const baseline = await loadBaseline(createAdminClient(), userId, today);
  const defaults = await defaultsFor(userId, today, baseline);
  return (
    <>
      <PageHeader title="Plan" />
      <div className="stagger space-y-3">
        <BaselineCard b={baseline} />
        <Card>
          <PlanForm defaults={defaults} />
        </Card>
      </div>
    </>
  );
}

