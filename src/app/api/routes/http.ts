import { NextResponse } from "next/server";
import { z } from "zod";
import { RoutingError } from "@/lib/routes/routing";

export const LngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** Turns routing failures into a JSON error the planner can show. */
export function routingErrorResponse(e: unknown) {
  if (e instanceof RoutingError) {
    return NextResponse.json({ error: e.message, kind: e.kind }, { status: e.kind === "unavailable" ? 503 : 422 });
  }
  return NextResponse.json({ error: "Routing failed. Try again.", kind: "unavailable" }, { status: 500 });
}
