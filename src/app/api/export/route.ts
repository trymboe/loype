import { NextResponse } from "next/server";
import { fetchAll } from "@/lib/db/paginate";
import { createUserClient, getSessionUser } from "@/lib/db/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Export all personal data (excluding raw time series and original files) as JSON. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await createUserClient();
  // table -> primary key, used for a stable order while paging past the 1000-row limit
  const tables: Record<string, string> = {
    athlete_profile: "user_id",
    activities: "id",
    activity_laps: "id",
    activity_splits: "id",
    workout_feedback: "activity_id",
    wellness_daily: "id",
    sync_jobs: "id",
  };
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  try {
    for (const [t, pk] of Object.entries(tables)) {
      out[t] = await fetchAll((from, to) => db.from(t).select("*").eq("user_id", user.id).order(pk).range(from, to));
    }
  } catch {
    // never hand out a silently incomplete export
    return NextResponse.json({ error: "Export failed; please try again." }, { status: 500 });
  }
  return new NextResponse(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="loype-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
