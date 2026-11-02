import Link from "next/link";
import { createUserClient } from "@/lib/db/server";
import { daysBetween, formatDay } from "@/lib/dates";
import { Steps } from "./steps";

/** Today's planned session (or the next one), shown on the Today page. */
export async function NextWorkout({ today }: { today: string }) {
  const db = await createUserClient();
  const { data: plan } = await db.from("training_plans").select("id").eq("status", "active").maybeSingle();
  if (!plan) {
    return (
      <Link href="/plan" className="card rise block p-5 transition-colors hover:border-muted/50">
        <div className="label">Plan</div>
        <p className="mt-1 text-sm">No training plan yet. Set a goal and get a plan built from your runs →</p>
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
    <Link href={`/plan/workouts/${w.id}`} className="card rise block border-accent/50 p-5 transition-colors hover:border-accent">
      <div className="label">{isToday ? "Today's workout" : `Next workout · ${formatDay(w.date)}`}</div>
      <p className="mt-1 font-display text-2xl font-semibold">{w.title}</p>
      {!isToday && <p className="text-xs text-muted">{daysBetween(today, w.date) === 1 ? "tomorrow" : `in ${daysBetween(today, w.date)} days`}</p>}
      {isToday && (
        <div className="mt-3">
          <Steps steps={w.steps} />
        </div>
      )}
    </Link>
  );
}
