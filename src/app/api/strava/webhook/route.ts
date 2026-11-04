import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/db/server";
import { syncTickForUser } from "@/lib/ingest/service";
import { userForAthlete } from "@/lib/ingest/strava-service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Strava's subscription check: echo hub.challenge when the verify token matches one we issued. */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const token = p.get("hub.verify_token");
  const challenge = p.get("hub.challenge");
  if (p.get("hub.mode") !== "subscribe" || !token || !challenge) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const db = createAdminClient();
  const { data } = await db.from("integrations").select("settings").eq("provider", "strava");
  const known = (data ?? []).some((r: { settings: { webhookVerifyToken?: string } | null }) => r.settings?.webhookVerifyToken === token);
  if (!known) return NextResponse.json({ error: "unknown verify token" }, { status: 403 });
  return NextResponse.json({ "hub.challenge": challenge });
}

/**
 * Activity events. Strava doesn't sign them, so an event is only a hint: the
 * import fetches from Strava with the athlete's own token and imports
 * whatever is really there. Must answer within 2 s, so the work runs after.
 */
export async function POST(request: NextRequest) {
  const ev = (await request.json().catch(() => null)) as { object_type?: string; aspect_type?: string; owner_id?: number } | null;
  if (ev?.object_type !== "activity" || ev.aspect_type !== "create" || !Number.isSafeInteger(ev.owner_id)) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  const db = createAdminClient();
  const userId = await userForAthlete(db, ev.owner_id!);
  if (!userId) return NextResponse.json({ ok: true, ignored: true });
  after(() => syncTickForUser(db, userId, { budgetMs: 50_000, createIncremental: true, only: "strava" }).catch(() => undefined));
  return NextResponse.json({ ok: true });
}
