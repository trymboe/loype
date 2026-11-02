import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { coachConfigured, runCoachTurn, type CoachEvent } from "@/lib/coach/service";
import { userTimezone } from "@/lib/user-tz";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid().nullable(),
  text: z.string().trim().min(1).max(4000),
});

function friendly(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API key was rejected. Check ANTHROPIC_API_KEY in Vercel.";
  if (err instanceof Anthropic.RateLimitError) return "The coach is rate-limited right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Try again.";
  if (err instanceof Anthropic.APIError) return `The Claude API returned an error (${err.status ?? "unknown"}). Try again.`;
  return "Something went wrong while the coach was answering. Try again.";
}

/** Streams the coach's answer as newline-delimited JSON events. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!coachConfigured()) return NextResponse.json({ error: "The coach needs ANTHROPIC_API_KEY to be set in Vercel." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const timezone = await userTimezone();
  const today = todayIn(timezone);
  const db = createAdminClient();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CoachEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        for await (const e of runCoachTurn({ db, userId: user.id, conversationId: parsed.data.conversationId, text: parsed.data.text, today, timezone })) send(e);
      } catch (err) {
        console.error("coach turn failed", err instanceof Error ? err.message : err);
        send({ type: "error", message: friendly(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
