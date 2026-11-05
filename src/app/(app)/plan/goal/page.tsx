import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { fmtDist } from "@/lib/analytics/fitness/estimate";
import { addDaysIso, formatDay } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { goalDistance } from "@/lib/planning/generator";
import { activePlan, goalFromRow } from "@/lib/planning/service";
import { GOAL_LABEL, type Baseline, type PlanConfig, type PlanWeek } from "@/lib/planning/types";
import { GOALS } from "../goal-options";
import { DeletePlan, GoalForm } from "./goal-form";

export const metadata = { title: "Goal" };
export const dynamic = "force-dynamic";

/** "1:50:00" / "24:00" for the target-time field */
function timeField(s: number | null): string {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export default async function GoalPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const plan = await activePlan(createAdminClient(), user.id);
  if (!plan) redirect("/plan/new");
  const goal = goalFromRow(plan.goal);
  const cfg = plan.config as PlanConfig;
  const weeks = plan.weeks as PlanWeek[];
  const d = goalDistance(goal);
  const kindLabel = GOALS.find((g) => g.kind === goal.kind)?.label ?? GOAL_LABEL[goal.kind];
  const facts: { label: string; value: string }[] = [
    { label: "Goal", value: kindLabel },
    ...(d && goal.kind === "race" ? [{ label: "Distance", value: fmtDist(d) }] : []),
    { label: goal.raceDate ? "Race date" : "Plan ends", value: goal.raceDate ? formatDay(goal.raceDate) : formatDay(addDaysIso(weeks.at(-1)!.start, 6)) },
    { label: "Started", value: formatDay(cfg.startDate) },
    { label: "Length", value: `${weeks.length} weeks` },
  ];

  return (
    <>
      <PageHeader back={{ href: "/plan", label: "Plan" }} title="Goal" subtitle="Change your target without touching your workouts, or adjust how you train." />
      <div className="stagger space-y-3">
        <Card>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
            {facts.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-muted">{f.label}</dt>
                <dd className="mt-0.5 text-[0.9375rem] font-semibold">{f.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted">The goal type, race date and length shape the whole plan, so they can only change with a new plan.</p>
        </Card>
        <Card>
          <GoalForm
            kind={goal.kind}
            initial={{
              name: goal.name ?? "",
              targetTime: timeField(goal.targetTimeS),
              targetWeeklyKm: goal.targetWeeklyKm != null ? String(goal.targetWeeklyKm) : "",
              runDays: cfg.runDays ?? [0, 1, 2, 3, 4, 5, 6],
              longRunDay: cfg.longRunDay ?? 6,
              maxWeeklyHours: cfg.maxWeeklyMinutes ? String(Math.round((cfg.maxWeeklyMinutes / 60) * 10) / 10) : "",
              includeIntervals: cfg.includeIntervals !== false,
              includeLongRuns: cfg.includeLongRuns !== false,
              includeStrides: cfg.includeStrides !== false,
              volume: cfg.volume ?? "steady",
              intensity: cfg.intensity ?? "balanced",
              runsPerWeek: cfg.runsPerWeek ?? null,
              usualRuns: cfg.usualRunsPerWeek != null ? String(cfg.usualRunsPerWeek) : "",
              recentRuns: (plan.baseline as Baseline | null)?.runsPerWeek ?? 0,
            }}
          />
        </Card>
        <Card>
          <DeletePlan />
        </Card>
      </div>
    </>
  );
}
