import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/db/server";
import { syncTickForUser } from "@/lib/ingest/service";
import { completeStravaConnect, verifyState } from "@/lib/ingest/strava-service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * OAuth redirect target. Public on purpose (see middleware): on iPhone the
 * redirect can land in Safari without the app's session, so the user is
 * identified by the signed `state` instead of a cookie.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const back = (q: Record<string, string>) => NextResponse.redirect(new URL(`/more/integrations?${new URLSearchParams(q)}#strava`, request.nextUrl.origin));
  const userId = verifyState(p.get("state") ?? "");
  if (!userId) return back({ strava_error: "The Strava sign-in link expired. Try connecting again." });
  if (p.get("error")) return back({ strava_error: p.get("error") === "access_denied" ? "You declined access on Strava." : `Strava: ${p.get("error")}` });
  const code = p.get("code");
  if (!code) return back({ strava_error: "Strava didn't send an authorization code." });

  const db = createAdminClient();
  let webhook = false;
  try {
    ({ webhook } = await completeStravaConnect(db, userId, code, p.get("scope"), request.nextUrl.origin));
  } catch (e) {
    return back({ strava_error: e instanceof Error ? e.message : String(e) });
  }
  // First import in the background so the redirect is instant.
  after(() => syncTickForUser(db, userId, { budgetMs: 50_000, createIncremental: true, only: "strava" }).catch(() => undefined));
  return back({ strava: webhook ? "connected" : "connected_no_webhook" });
}
