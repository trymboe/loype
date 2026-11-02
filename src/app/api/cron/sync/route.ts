import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/db/server";
import { env } from "@/lib/env";
import { syncTickForUser } from "@/lib/ingest/service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Scheduled sync. Called every 30 minutes by Supabase pg_cron (migration 0005,
 * bearer token kept in Supabase Vault) and daily by Vercel Cron
 * (`Authorization: Bearer $CRON_SECRET`) as a backstop.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const db = createAdminClient();
  const bySecret = !!process.env.CRON_SECRET && sameSecret(auth, `Bearer ${env.cronSecret()}`);
  if (!bySecret && !(await validSchedulerToken(db, auth))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: rows, error } = await db.from("integrations").select("user_id").eq("provider", "garmin").neq("status", "not_configured");
  if (error) return NextResponse.json({ error: "database error" }, { status: 500 });
  const results = [];
  for (const r of rows ?? []) {
    const out = await syncTickForUser(db, r.user_id, { budgetMs: 50_000, createIncremental: true });
    await markScheduledRun(db, r.user_id);
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

/** pg_cron's token lives in Supabase Vault; the database checks it (service role only). */
async function validSchedulerToken(db: SupabaseClient, header: string): Promise<boolean> {
  const m = /^Bearer (\S{32,256})$/.exec(header);
  if (!m) return false;
  const { data, error } = await db.rpc("verify_scheduler_token", { p_token: m[1] });
  return !error && data === true;
}

/** Shown on the Integrations page so it's visible that the scheduler is alive. */
async function markScheduledRun(db: SupabaseClient, userId: string) {
  const { data } = await db.from("integrations").select("settings").eq("user_id", userId).eq("provider", "garmin").maybeSingle();
  await db
    .from("integrations")
    .update({ settings: { ...(data?.settings ?? {}), lastScheduledRunAt: new Date().toISOString() } })
    .eq("user_id", userId)
    .eq("provider", "garmin");
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
