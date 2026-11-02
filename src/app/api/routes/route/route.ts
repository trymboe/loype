import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/db/server";
import { routingProvider } from "@/lib/routes/routing";
import { LngLatSchema, routingErrorResponse } from "../http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({ waypoints: z.array(LngLatSchema).min(2).max(25) });

/** Routes along runnable paths between waypoints; one coordinate list per leg. */
export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid waypoints" }, { status: 400 });
  try {
    const router = routingProvider();
    const res = await router.route(body.data.waypoints);
    return NextResponse.json({ ...res, provider: router.name });
  } catch (e) {
    return routingErrorResponse(e);
  }
}
