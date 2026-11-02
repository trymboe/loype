import { NextResponse, type NextRequest } from "next/server";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { addDaysIso, todayIn, weekStart } from "@/lib/dates";
import { revealHighlights, type RevealRunLike } from "@/lib/reveal";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

/** Runs older than this are history (a backfill), not something to celebrate. */
const FRESH_DAYS = 4;
const LOOKBACK_DAYS = 90;
const COLS = "id, name, start_time, local_date, utc_offset_s, sport, distance_m, moving_s, avg_speed_moving, avg_hr, elevation_gain_m, is_indoor, route_preview, created_at";

/**
 * Runs imported since the client's cursor (`after`, an activity created_at), newest first,
 * with highlights and the planned workout they completed. `latest=1` returns the latest run
 * regardless of the cursor (replay). Without either, it only returns the current cursor.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await createUserClient();
  const after = request.nextUrl.searchParams.get("after");
  const latest = request.nextUrl.searchParams.get("latest") === "1";

  const { data: newest } = await db.from("activities").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const cursor: string | null = newest?.created_at ?? after ?? null;

  if (!latest && (!after || Number.isNaN(Date.parse(after)))) return NextResponse.json({ cursor, runs: [] });

  let q = db.from("activities").select(COLS).eq("sport", "running").is("duplicate_of", null);
  if (latest) q = q.order("start_time", { ascending: false }).limit(1);
  else
    q = q
      .gt("created_at", after!)
      .gte("start_time", new Date(Date.now() - FRESH_DAYS * 86400_000).toISOString())
      .order("start_time", { ascending: false })
      .limit(3);
  const { data: fresh, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!fresh?.length) return NextResponse.json({ cursor, runs: [] });

  const tz = await userTimezone();
  const oldestDate = fresh[fresh.length - 1].local_date as string;
  const windowStart = addDaysIso(oldestDate, -LOOKBACK_DAYS);
  const ids = fresh.map((r) => r.id as string);
  const [{ data: prior }, { data: planned }] = await Promise.all([
    db
      .from("activities")
      .select("id, local_date, distance_m, avg_speed_moving, moving_s, start_time")
      .eq("sport", "running")
      .is("duplicate_of", null)
      .gte("local_date", windowStart)
      .order("start_time", { ascending: true })
      .limit(1000),
    db.from("planned_workouts").select("activity_id, title, type, key").in("activity_id", ids),
  ]);
  const priorRuns = (prior ?? []) as (RevealRunLike & { start_time: string })[];

  const runs = fresh.map((r) => {
    const before = priorRuns.filter((p) => p.start_time < r.start_time);
    const plan = planned?.find((p) => p.activity_id === r.id);
    const highlights = revealHighlights(r as RevealRunLike, before, windowStart, weekStart(r.local_date as string));
    if (plan) highlights.unshift({ kind: "plan", text: `Completed: ${plan.title}` });
    return { ...r, highlights, plan: plan ? { title: plan.title as string, type: plan.type as string, key: !!plan.key } : null };
  });
  return NextResponse.json({ cursor, runs, today: todayIn(tz) });
}
