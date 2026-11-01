import { NextResponse } from "next/server";
import { createUserClient, getSessionUser } from "@/lib/db/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Export all personal data (excluding raw time series and original files) as JSON. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await createUserClient();
  const tables = ["athlete_profile", "activities", "activity_laps", "activity_splits", "workout_feedback", "wellness_daily", "sync_jobs"];
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const t of tables) {
    const { data } = await db.from(t).select("*").eq("user_id", user.id);
    out[t] = data ?? [];
  }
  return new NextResponse(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="loype-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
