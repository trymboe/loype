import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/db/server";
import { generateLoop, routingProvider } from "@/lib/routes/routing";
import { findSoftLoop } from "@/lib/routes/soft-loop";
import { findFlatLoop } from "@/lib/routes/flat-loop";
import { LngLatSchema, routingErrorResponse } from "../http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  start: LngLatSchema,
  distanceM: z.number().min(1000).max(50_000),
  bearing: z.number().min(0).max(360),
  /** Compare several loops and keep the one with the most gravel and trail. */
  soft: z.boolean().optional(),
  /** With `soft`: the loop may start anywhere within this walk of `start`. */
  startRadiusM: z.number().min(0).max(3000).optional(),
  /** Compare loops in a few directions and keep the one with the least climbing. */
  flat: z.boolean().optional(),
});

/** Generates a loop of roughly the requested distance from a start point (optionally the softest of several). */
export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid loop request" }, { status: 400 });
  try {
    const router = routingProvider();
    const { start, distanceM, bearing, soft, startRadiusM = 0, flat } = body.data;
    if (flat && !soft) return NextResponse.json({ ...(await findFlatLoop(router, start, distanceM, bearing)), provider: router.name });
    if (soft) return NextResponse.json({ ...(await findSoftLoop(router, start, distanceM, bearing, startRadiusM)), provider: router.name });
    const res = await generateLoop(router, start, distanceM, bearing);
    return NextResponse.json({ ...res, provider: router.name });
  } catch (e) {
    return routingErrorResponse(e);
  }
}
