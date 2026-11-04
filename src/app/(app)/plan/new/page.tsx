import { redirect } from "next/navigation";
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
  // with a plan running, the goal is edited in place; a new plan needs the current one deleted first
  if (await activePlan(db, user.id)) redirect("/plan/goal");
  const baseline = await loadBaseline(db, user.id, today);
  const defaults = await defaultsFor(user.id, today, baseline);
  return (
    <>
      <PageHeader back={{ href: "/plan", label: "Plan" }} title="New plan" />
      <div className="stagger space-y-3">
        <BaselineCard b={baseline} />
        <Card>
          <PlanForm defaults={defaults} />
        </Card>
      </div>
    </>
  );
}
