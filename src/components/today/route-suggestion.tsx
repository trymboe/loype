import { SuggestedRoutes, type SuggestFor } from "@/components/routes/suggested-routes";
import { createUserClient } from "@/lib/db/server";

/** Routes that fit today's planned run (or the next one), shown on the Today page. */
export async function RouteSuggestion({ today }: { today: string }) {
  const db = await createUserClient();
  const { data: plan } = await db.from("training_plans").select("id").eq("status", "active").maybeSingle();
  if (!plan) return null;
  const { data: w } = await db
    .from("planned_workouts")
    .select("id, type, duration_s, distance_m, steps, route_id")
    .eq("plan_id", plan.id)
    .gte("date", today)
    .eq("status", "planned")
    .neq("type", "rest")
    .order("date")
    .limit(1)
    .maybeSingle();
  if (!w) return null;
  return <SuggestedRoutes workout={w as SuggestFor} today={today} />;
}
