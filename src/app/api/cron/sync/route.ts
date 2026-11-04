import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/db/server";
import { env } from "@/lib/env";
import { syncTickForUser } from "@/lib/ingest/service";
import { todayIn } from "@/lib/dates";
import { pushPlannedWorkouts } from "@/lib/outbound/service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Scheduled sync. Called by Supabase pg_cron (every 30 min) and Vercel Cron
 * (daily backstop) with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${env.cronSecret()}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: rows, error } = await db.from("integrations").select("user_id").in("provider", ["garmin", "strava"]).neq("status", "not_configured");
  if (error) return NextResponse.json({ error: "database error" }, { status: 500 });
  const results = [];
  for (const userId of new Set((rows ?? []).map((r) => r.user_id as string))) {
    const out = await syncTickForUser(db, userId, { budgetMs: 50_000, createIncremental: true });
    results.push({
      configured: out.configured,
      done: out.done,
      processed: out.processedThisTick,
      counters: out.counters,
      authError: out.authError ? true : undefined,
      error: out.error ? true : undefined,
    });
  }
  // Outbound: keep Intervals.icu (→ Garmin) in step with the plan. Separate from the import above.
  const outbound = [];
  const { data: outRows } = await db.from("integrations").select("user_id").eq("provider", "intervals_icu").neq("status", "not_configured");
  for (const r of outRows ?? []) {
    const { data: profile } = await db.from("athlete_profile").select("timezone").eq("user_id", r.user_id).maybeSingle();
    const res = await pushPlannedWorkouts(db, r.user_id, todayIn(profile?.timezone ?? "Europe/Oslo")).catch(() => null);
    outbound.push(res ? { sent: res.sent, removed: res.removed, failed: res.failed, error: res.error ? true : undefined } : { error: true });
  }
  return NextResponse.json({ ok: true, results, outbound });
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
