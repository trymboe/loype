import { Card, PageHeader } from "@/components/ui";
import { BaselineCard, defaultsFor } from "@/components/plan/plan-start";
import { PlanForm } from "../plan-form";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { activePlan, loadBaseline } from "@/lib/planning/service";
import { userTimezone } from "@/lib/user-tz";

export const metadata = { title: "New plan" };
export const dynamic = "force-dynamic";

export default async function NewPlanPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const today = todayIn(await userTimezone());
  const db = createAdminClient();
  const [baseline, defaults, plan] = await Promise.all([loadBaseline(db, user.id, today), defaultsFor(user.id, today), activePlan(db, user.id)]);
  return (
    <>
      <PageHeader back={{ href: "/plan", label: "Plan" }} title={plan ? "Change goal" : "New plan"} subtitle={plan ? "Builds a new plan from today. The current plan and its history are kept under History." : undefined} />
      <div className="stagger space-y-3">
        <BaselineCard b={baseline} />
        <Card>
          <PlanForm defaults={defaults} replacing={!!plan} />
        </Card>
      </div>
    </>
  );
}
