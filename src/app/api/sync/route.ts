import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { getGarminIntegration, syncTickForUser } from "@/lib/ingest/service";
import { todayIn } from "@/lib/dates";
import { pushPlannedWorkouts } from "@/lib/outbound/service";
import { userTimezone } from "@/lib/user-tz";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("historical"), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

/** Current sync status for the signed-in user. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createAdminClient();
  const integration = await getGarminIntegration(db, user.id);
  const { data: jobs } = await db
    .from("sync_jobs")
    .select("id, kind, status, range_start, range_end, discovered, processed, failed, unavailable, skipped, last_error, created_at, finished_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(5);
  return NextResponse.json({
    integration: integration && {
      status: integration.status,
      lastSuccessAt: integration.last_success_at,
      lastError: integration.last_error,
      apiKeyExpiresAt: integration.api_key_expires_at,
      hasKey: Boolean(integration.api_key_ciphertext) || Boolean(process.env.GARMIN_PERSONAL_API_KEY),
    },
    jobs: jobs ?? [],
  });
}

/** Run one bounded sync tick (optionally starting a historical import). */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const body = parsed.data;
  if (body.action === "historical" && Date.parse(body.from) > Date.now()) {
    return NextResponse.json({ error: "start date is in the future" }, { status: 400 });
  }
  const db = createAdminClient();
  const out = await syncTickForUser(db, user.id, {
    budgetMs: 45_000,
    createIncremental: body.action === "sync",
    historicalFrom: body.action === "historical" ? body.from : undefined,
  });
  // Outbound workouts are independent of the Garmin import: run even if it failed, never let it fail the request.
  if (body.action === "sync" || out.done) {
    await pushPlannedWorkouts(db, user.id, todayIn(await userTimezone())).catch(() => null);
  }
  if (!out.configured) return NextResponse.json({ error: "Garmin is not connected" }, { status: 409 });
  return NextResponse.json({
    done: out.done ?? false,
    processed: out.processedThisTick ?? 0,
    counters: out.counters ?? null,
    authError: out.authError ?? null,
    error: out.error ?? null,
  });
}
