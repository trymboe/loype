import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { env } from "@/lib/env";
import { getOrCreateCheckin } from "@/lib/coach/checkin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The coach's check-in on a key session, generated on first request and cached. `{ text: null }` when there is none. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ text: null });
  const key = env.openaiApiKey();
  try {
    const c = await getOrCreateCheckin(createAdminClient(), user.id, id, key ? new OpenAI({ apiKey: key }) : null);
    return NextResponse.json({ text: c?.text ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // the check-in is optional: the page just shows nothing
    console.error("coach check-in failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ text: null });
  }
}
