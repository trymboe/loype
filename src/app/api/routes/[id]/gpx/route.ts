import { NextResponse } from "next/server";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { gpxFileName, routeToGpx } from "@/lib/routes/gpx";

export const dynamic = "force-dynamic";

/** Saved route as a GPX track. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const db = await createUserClient();
  const { data } = await db.from("routes").select("name, coords, elevations").eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(routeToGpx(data.name, data.coords, data.elevations), {
    headers: {
      "content-type": "application/gpx+xml; charset=utf-8",
      "content-disposition": `attachment; filename="${gpxFileName(data.name)}"`,
    },
  });
}
