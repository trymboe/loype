import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/db/server";
import { env } from "@/lib/env";
import { syncTickForUser } from "@/lib/ingest/service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Scheduled sync. Called by Supabase pg_cron (every 30 min) and Vercel Cron
 * (daily backstop) with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: rows, error } = await db.from("integrations").select("user_id").eq("provider", "garmin").neq("status", "not_configured");
  if (error) return NextResponse.json({ error: "database error" }, { status: 500 });
  const results = [];
  for (const r of rows ?? []) {
    const out = await syncTickForUser(db, r.user_id, { budgetMs: 50_000, createIncremental: true });
    results.push({
      configured: out.configured,
      done: out.done,
      processed: out.processedThisTick,
      counters: out.counters,
      authError: out.authError ? true : undefined,
      error: out.error ? true : undefined,
    });
  }
  return NextResponse.json({ ok: true, results });
}
