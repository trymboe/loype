import Link from "next/link";
import { CalendarDays, ChevronRight } from "lucide-react";
import { IconTile } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { daysBetween, formatDay } from "@/lib/dates";
import { Steps } from "./steps";

/** Today's planned session (or the next one), shown on the Today page. */
export async function NextWorkout({ today }: { today: string }) {
  const db = await createUserClient();
  const { data: plan } = await db.from("training_plans").select("id").eq("status", "active").maybeSingle();
  if (!plan) {
    return (
      <Link href="/plan" className="card flex items-center gap-3.5 p-4 hover:bg-surface-2/40">
        <IconTile color="var(--accent)">
          <CalendarDays size={18} />
        </IconTile>
        <div className="min-w-0 flex-1">
          <p className="text-[0.9375rem] font-semibold">No training plan yet</p>
          <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">Set a goal and get a plan built from your runs.</p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-subtle" />
      </Link>
    );
  }
  const { data: w } = await db
    .from("planned_workouts")
    .select("id, date, title, why, steps, status, type")
    .eq("plan_id", plan.id)
    .gte("date", today)
    .eq("status", "planned")
    .neq("type", "rest")
    .order("date")
    .limit(1)
    .maybeSingle();
  if (!w) return null;
  const isToday = w.date === today;
  return (
    <Link href={`/plan/workouts/${w.id}`} className="card relative block overflow-hidden p-5 hover:bg-surface-2/40">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">{isToday ? "Today's workout" : `Next workout · ${formatDay(w.date)}`}</p>
        <ChevronRight size={18} className="shrink-0 text-subtle" />
      </div>
      <p className="mt-1 text-[1.375rem] leading-tight font-semibold tracking-[-0.02em]">{w.title}</p>
      {!isToday && <p className="mt-0.5 text-[0.8125rem] text-muted">{daysBetween(today, w.date) === 1 ? "Tomorrow" : `In ${daysBetween(today, w.date)} days`}</p>}
      {isToday && (
        <div className="mt-4">
          <Steps steps={w.steps} />
        </div>
      )}
    </Link>
  );
}
