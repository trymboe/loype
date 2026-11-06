import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader, Stat } from "@/components/ui";
import { RouteView } from "@/components/routes/route-view";
import { RouteActions } from "@/components/routes/route-actions";
import { LinkWorkout } from "@/components/routes/link-workout";
import { getRoute } from "@/lib/db/queries";
import { createUserClient } from "@/lib/db/server";
import { addDaysIso, formatDay, todayIn } from "@/lib/dates";
import { WORKOUT_LABEL, type WorkoutType } from "@/lib/planning/types";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

const SOURCE = { drawn: "Drawn on the map", loop: "Generated loop", activity: "From a recorded run" } as const;

export default async function RoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const r = await getRoute(id);
  if (!r) notFound();
  const today = todayIn(await userTimezone());
  const db = await createUserClient();
  const { data: upcoming } = await db
    .from("planned_workouts")
    .select("id, date, type, title, distance_m, route_id, plan:training_plans!inner(status)")
    .eq("plan.status", "active")
    .eq("status", "planned")
    .gte("date", today)
    .lte("date", addDaysIso(today, 42))
    .order("date")
    .limit(60);
  const workouts = ((upcoming ?? []) as { id: string; date: string; type: string; title: string; distance_m: number | null; route_id: string | null }[])
    .filter((w) => w.type !== "rest")
    .map((w) => ({
      id: w.id,
      label: `${formatDay(w.date)} · ${w.title}`,
      sub: `${WORKOUT_LABEL[w.type as WorkoutType] ?? w.type}${w.distance_m ? ` · ≈ ${(w.distance_m / 1000).toFixed(1)} km` : ""}`,
      linkedHere: w.route_id === r.id,
      linkedElsewhere: w.route_id != null && w.route_id !== r.id,
    }));

  return (
    <>
      <PageHeader
        back={{ href: "/routes", label: "Routes" }}
        title={r.name}
        subtitle={
          <span className="mt-1 flex flex-wrap gap-1.5">
            <Badge>{SOURCE[r.source as keyof typeof SOURCE]}</Badge>
            {r.favorite && <Badge tone="warn">Favourite</Badge>}
          </span>
        }
      />
      <div className="stagger space-y-3">
        <section className="card grid grid-cols-3 gap-4 p-5">
          <Stat label="Distance" value={(r.distance_m / 1000).toFixed(2)} unit="km" />
          <Stat label="Climb" value={r.elevation_gain_m != null ? `+${Math.round(r.elevation_gain_m)}` : "–"} unit="m" />
          <Stat label="Descent" value={r.elevation_loss_m != null ? `−${Math.round(r.elevation_loss_m)}` : "–"} unit="m" />
        </section>
        <RouteView coords={r.coords} elevations={r.elevations} gps={r.source === "activity"} />
        {r.elevations == null && <p className="px-1 text-xs text-muted">Elevation unavailable</p>}
        <RouteActions id={r.id} name={r.name} favorite={r.favorite} editable={r.source !== "activity"} coords={r.coords} />
        <LinkWorkout routeId={r.id} workouts={workouts} />
        {r.activity_id && (
          <p className="px-1 text-sm">
            <Link href={`/activities/${r.activity_id}`} className="font-semibold text-accent">
              Open the original run
            </Link>
          </p>
        )}
      </div>
    </>
  );
}
