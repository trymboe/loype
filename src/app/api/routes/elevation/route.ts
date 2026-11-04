import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/db/server";
import { elevationAlong } from "@/lib/routes/elevation";
import { routingProvider } from "@/lib/routes/routing";
import { LngLatSchema, routingErrorResponse } from "../http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({ coords: z.array(LngLatSchema).min(1).max(20_000) });

/** Elevation (m) for each coordinate of a route, from an OSM-based elevation model. */
export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  try {
    return NextResponse.json({ elevations: await elevationAlong(routingProvider(), body.data.coords) });
  } catch (e) {
    return routingErrorResponse(e);
  }
}
