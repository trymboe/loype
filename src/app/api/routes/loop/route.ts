import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/db/server";
import { generateLoop, routingProvider } from "@/lib/routes/routing";
import { LngLatSchema, routingErrorResponse } from "../http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  start: LngLatSchema,
  distanceM: z.number().min(1000).max(50_000),
  bearing: z.number().min(0).max(360),
});

/** Generates a loop of roughly the requested distance from a start point. */
export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid loop request" }, { status: 400 });
  try {
    const router = routingProvider();
    const res = await generateLoop(router, body.data.start, body.data.distanceM, body.data.bearing);
    return NextResponse.json({ ...res, provider: router.name });
  } catch (e) {
    return routingErrorResponse(e);
  }
}
