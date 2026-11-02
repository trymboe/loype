import { NextResponse } from "next/server";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { encodeWorkoutFit, fitFileName } from "@/lib/fit/workout-encode";

export const dynamic = "force-dynamic";

/** Manual fallback: the planned workout as a FIT workout file. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const db = await createUserClient();
  const { data: w } = await db.from("planned_workouts").select("date, title, steps").eq("id", id).maybeSingle();
  if (!w) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!Array.isArray(w.steps) || !w.steps.length) return NextResponse.json({ error: "This workout has no steps to export" }, { status: 409 });
  const bytes = encodeWorkoutFit({ title: w.title, steps: w.steps });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.ant.fit",
      "Content-Disposition": `attachment; filename="${fitFileName(w.date, w.title)}"`,
      "Cache-Control": "no-store",
    },
  });
}
