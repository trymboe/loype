import { NextResponse } from "next/server";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { gpxFileName, toGpx, type GpxPoint } from "@/lib/routes/gpx";

export const dynamic = "force-dynamic";

/** A recorded run as GPX (track points with time, elevation, heart rate and cadence). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const db = await createUserClient();
  const [{ data: a }, { data: s }] = await Promise.all([
    db.from("activities").select("name, start_time, local_date").eq("id", id).maybeSingle(),
    db.from("activity_streams").select("t, lat, lng, altitude, hr, cadence").eq("activity_id", id).maybeSingle(),
  ]);
  if (!a || !s?.lat || !s?.lng) return NextResponse.json({ error: "This activity has no GPS track" }, { status: 404 });
  const start = new Date(a.start_time).getTime();
  const points: GpxPoint[] = [];
  for (let i = 0; i < s.t.length; i++) {
    if (s.lat[i] == null || s.lng[i] == null) continue;
    points.push({ lat: s.lat[i], lng: s.lng[i], ele: s.altitude?.[i] ?? null, time: new Date(start + s.t[i] * 1000), hr: s.hr?.[i] ?? null, cad: s.cadence?.[i] ?? null });
  }
  if (points.length < 2) return NextResponse.json({ error: "This activity has no GPS track" }, { status: 404 });
  const name = a.name ?? `Run ${a.local_date}`;
  return new NextResponse(toGpx({ name, points, time: new Date(start) }), {
    headers: {
      "content-type": "application/gpx+xml; charset=utf-8",
      "content-disposition": `attachment; filename="${gpxFileName(`${a.local_date} ${name}`)}"`,
    },
  });
}
