import Link from "next/link";
import clsx from "clsx";
import { Check, ChevronRight, Lock, Minus, X } from "lucide-react";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { ProposalCard, type ProposalRow } from "@/components/plan/proposal-card";
import { PlanForm } from "./plan-form";
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

export default async function PlanPage() {
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
      .or(`status.eq.pending,and(status.eq.accepted,decided_at.gte.${addDaysIso(today, -14)})`)
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
  const todays = ws.filter((w) => w.date === today && w.type !== "rest");

  return (
    <>
      <PageHeader
        title="Plan"
        subtitle={title}
        action={
          <div className="flex gap-2 text-xs">
            <Link href="/plan/history" className="rounded-full bg-surface-2 px-3 py-1.5 text-muted hover:text-fg">
              History
            </Link>
            <Link href="/plan/new" className="rounded-full bg-surface-2 px-3 py-1.5 text-muted hover:text-fg">
              Change goal
            </Link>
          </div>
        }
      />
      <div className="space-y-4">
        {pending.map((p: any) => (
          <ProposalCard key={p.id} p={p as ProposalRow} />
        ))}

        <Card>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {goal.race_date ? (
              <Stat label="Race day" value={daysBetween(today, goal.race_date)} unit="days" hint={formatDay(goal.race_date)} />
            ) : (
              <Stat label="Plan ends" value={formatDay(addDaysIso(weeks.at(-1)!.start, 6))} size="md" hint={`${weeks.length} weeks`} />
            )}
            {d && pred && <Stat label="Predicted now" value={fmtTime((pred * d) / 1000)} size="md" hint={`${formatPace(pred)}/km`} />}
            {goal.target_time_s && <Stat label="Target" value={fmtTime(goal.target_time_s)} size="md" hint={d ? `${formatPace(goal.target_time_s / (d / 1000))}/km` : undefined} />}
            {plan.race_pace && <Stat label="Training race pace" value={formatPace(plan.race_pace)} unit="/km" size="md" />}
          </div>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted">How this plan was built</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {(plan.summary as string[]).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              <li>
                Built from your last 4 weeks ({baseline.weeklyMinutes} min/week, {baseline.runsPerWeek} runs/week) and{" "}
                {baseline.vdot ? `your fitness estimate (VDOT ${baseline.vdot.toFixed(1)}, ${baseline.vdotConfidence} confidence)` : "heart-rate zones (no fitness estimate yet)"}.
              </li>
            </ul>
          </details>
          {(plan.warnings as string[]).length > 0 && (
            <ul className="mt-3 space-y-1">
              {(plan.warnings as string[]).map((w, i) => (
                <li key={i} className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {todays.length > 0 && (
          <Card>
            <div className="label">Today</div>
            {todays.map((w) => (
              <WorkoutRow key={w.id} w={w} today={today} big />
            ))}
          </Card>
        )}

        <PhaseBar weeks={weeks} current={thisWeek} />

        {weeks.map((wk) => {
          const end = addDaysIso(wk.start, 6);
          const items = ws.filter((w) => w.date >= wk.start && w.date <= end);
          const isCurrent = wk.start === thisWeek;
          const past = end < today;
          const planned = items.filter((w) => w.status !== "skipped").reduce((a, w) => a + w.duration_s / 60, 0);
          const ran = ranBy.get(wk.start) ?? 0;
          return (
            <details key={wk.start} open={isCurrent || (wk.start > thisWeek && wk.start <= addDaysIso(thisWeek, 7))} className={clsx("card rise p-4", isCurrent && "border-accent/60")}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">
                    Week {wk.index + 1} · {formatDay(wk.start, { day: "numeric", month: "short" })}
                    {isCurrent && <span className="ml-2 text-accent">this week</span>}
                  </div>
                  <div className="text-xs text-muted">{wk.note || PHASE_LABEL[wk.phase]}</div>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <Badge tone={wk.phase === "recovery" || wk.phase === "taper" ? "muted" : wk.phase === "race" ? "hr" : "accent"}>{PHASE_LABEL[wk.phase]}</Badge>
                  <div className="tabular w-20 text-xs text-muted">
                    {past || isCurrent ? `${Math.round(ran)} / ` : ""}
                    {Math.round(planned)} min
                  </div>
                </div>
              </summary>
              <ul className="mt-3 divide-y divide-border">
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
            <div className="label">Recently applied</div>
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
  if (status === "completed") return <Check size={16} className="text-accent" />;
  if (status === "missed") return <X size={16} className="text-hr" />;
  if (status === "skipped") return <Minus size={16} className="text-muted" />;
  return <span className={clsx("block h-2.5 w-2.5 rounded-full", past ? "bg-muted/40" : "bg-border")} />;
}

function WorkoutRow({ w, today, big }: { w: any; today: string; big?: boolean }) {
  const hard = isHard(w.type);
  return (
    <Link href={`/plan/workouts/${w.id}`} className="flex items-center gap-3 py-2.5">
      <div className="w-10 shrink-0 text-xs text-muted">{formatDay(w.date, { weekday: "short" })}</div>
      <div className="flex w-4 justify-center">
        <StatusIcon status={w.status} past={w.date < today} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={clsx("truncate", big ? "font-display text-xl font-semibold" : "text-sm", w.status === "skipped" && "text-muted line-through")}>
          {w.title}
          {w.locked && <Lock size={12} className="ml-1 inline text-muted" />}
        </div>
        {w.execution?.verdict && w.execution.verdict !== "as_planned" && <div className="text-xs text-muted">{w.execution.notes?.[0]}</div>}
      </div>
      <div className="flex items-center gap-1.5">
        {hard && <span className="h-2 w-2 rounded-full bg-hr" title="Hard session" />}
        <span className="tabular text-xs text-muted">{Math.round(w.duration_s / 60)} min</span>
        <ChevronRight size={14} className="text-muted" />
      </div>
    </Link>
  );
}

function PhaseBar({ weeks, current }: { weeks: PlanWeek[]; current: string }) {
  const color: Record<Phase, string> = { base: "bg-accent/40", build: "bg-accent/70", specific: "bg-accent", recovery: "bg-surface-2", taper: "bg-warn/50", race: "bg-hr" };
  const max = Math.max(...weeks.map((w) => w.targetMinutes), 1);
  return (
    <Card>
      <div className="label mb-3">Phases and weekly time</div>
      <div className="flex h-24 items-end gap-0.5">
        {weeks.map((w) => (
          <div key={w.start} className="flex flex-1 flex-col items-center justify-end" title={`Week ${w.index + 1}: ${PHASE_LABEL[w.phase]}, ${w.targetMinutes} min`}>
            <div className={clsx("w-full rounded-t", color[w.phase], w.start === current && "ring-2 ring-fg")} style={{ height: `${Math.max(6, (w.targetMinutes / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
        {(["base", "build", "specific", "recovery", "taper", "race"] as Phase[])
          .filter((p) => weeks.some((w) => w.phase === p))
          .map((p) => (
            <span key={p} className="inline-flex items-center gap-1">
              <span className={clsx("h-2 w-2 rounded-sm", color[p])} />
              {PHASE_LABEL[p]}
            </span>
          ))}
      </div>
    </Card>
  );
}

async function NoPlan({ userId, today }: { userId: string; today: string }) {
  const [baseline, defaults] = await Promise.all([loadBaseline(createAdminClient(), userId, today), defaultsFor(userId, today)]);
  return (
    <>
      <PageHeader title="Plan" subtitle="Set a goal and Løype builds a plan from your actual training." />
      <div className="space-y-4">
        <BaselineCard b={baseline} />
        <Card>
          <PlanForm defaults={defaults} />
        </Card>
      </div>
    </>
  );
}

