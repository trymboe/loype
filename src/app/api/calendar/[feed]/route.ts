import { NextResponse, type NextRequest } from "next/server";
import { renderFeed } from "@/lib/calendar/service";
import { createAdminClient } from "@/lib/db/server";

export const dynamic = "force-dynamic";

/**
 * iCalendar subscription feed: /api/calendar/<token>.ics
 * Public on purpose (calendar apps can't sign in); the 192-bit token in the
 * URL is the credential and can be rotated or turned off under More → Calendar.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ feed: string }> }) {
  const { feed } = await params;
  const token = feed.replace(/\.ics$/i, "");
  let body: string | null;
  try {
    body = await renderFeed(createAdminClient(), token, request.nextUrl.origin);
  } catch {
    return NextResponse.json({ error: "Calendar unavailable, try again later" }, { status: 503 });
  }
  if (!body) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="loype.ics"',
      "cache-control": "private, max-age=900",
      "x-robots-tag": "noindex",
    },
  });
}
