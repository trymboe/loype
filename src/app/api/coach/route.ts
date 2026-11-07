import { NextResponse, type NextRequest } from "next/server";
import OpenAI from "openai";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { checkinContext } from "@/lib/coach/checkin";
import { coachConfigured, runCoachTurn, type CoachEvent } from "@/lib/coach/service";
import { userTimezone } from "@/lib/user-tz";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid().nullable(),
  text: z.string().trim().min(1).max(4000),
  /** a follow-up opened from this run's check-in */
  activityId: z.string().uuid().nullish(),
});

function friendly(err: unknown): string {
  if (err instanceof OpenAI.AuthenticationError) return "The OpenAI API key was rejected. Check OPENAI_API_KEY in Vercel.";
  if (err instanceof OpenAI.RateLimitError) return "The coach is rate-limited or out of API credit right now. Check your OpenAI billing, or try again in a minute.";
  if (err instanceof OpenAI.APIConnectionError) return "Couldn't reach the OpenAI API. Try again.";
  if (err instanceof OpenAI.APIError) return `The OpenAI API returned an error (${err.status ?? "unknown"}). Try again.`;
  return "Something went wrong while the coach was answering. Try again.";
}

/** Streams the coach's answer as newline-delimited JSON events. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!coachConfigured()) return NextResponse.json({ error: "The coach needs OPENAI_API_KEY to be set in Vercel." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const timezone = await userTimezone();
  const today = todayIn(timezone);
  const db = createAdminClient();
  const context = parsed.data.activityId ? await checkinContext(db, user.id, parsed.data.activityId).catch(() => null) : null;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CoachEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      let changed = false;
      try {
        for await (const e of runCoachTurn({ db, userId: user.id, conversationId: parsed.data.conversationId, text: parsed.data.text, today, timezone, context })) {
          if (e.type === "actions") changed = true;
          send(e);
        }
      } catch (err) {
        console.error("coach turn failed", err instanceof Error ? err.message : err);
        send({ type: "error", message: friendly(err) });
      } finally {
        if (changed) {
          revalidatePath("/plan", "layout");
          revalidatePath("/routes", "layout");
          revalidatePath("/activities", "layout");
          revalidatePath("/");
        }
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
