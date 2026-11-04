import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/db/server";
import { densify, lineLength, sampleIndices, simplify } from "@/lib/routes/geometry";
import { routingProvider } from "@/lib/routes/routing";
import { LngLatSchema, routingErrorResponse } from "../http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({ coords: z.array(LngLatSchema).min(2).max(50_000), gps: z.boolean().optional() });

/** Longest line we ask the matcher about (the public Valhalla caps trace length). */
const MAX_M = 150_000;

/**
 * Surface breakdown along a planned route or a recorded run, from OpenStreetMap
 * surface tags via Valhalla map matching.
 */
export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  const { coords, gps = false } = body.data;
  if (lineLength(coords) > MAX_M) return NextResponse.json({ error: "Route is too long for a surface lookup." }, { status: 422 });
  // Planned lines are sparse after simplification: fill them in so the matcher
  // follows the same paths. GPS tracks are dense already: thin them a little.
  const pts = gps ? simplify(coords, 3) : densify(coords, 40);
  const shape = pts.length > 4000 ? sampleIndices(pts.length, 4000).map((i) => pts[i]) : pts;
  try {
    const res = await routingProvider().surfaces(shape, { gps });
    // Trim the coloured stretches to what the map needs.
    return NextResponse.json({ ...res, segments: res.segments.map((s) => ({ cls: s.cls, coords: simplify(s.coords, 2) })) });
  } catch (e) {
    return routingErrorResponse(e);
  }
}
