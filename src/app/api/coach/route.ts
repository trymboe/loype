import { after, NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { checkinContext } from "@/lib/coach/checkin";
import { coachConfigured, loadTranscript, runCoachTurn, turnInProgress, type CoachEvent } from "@/lib/coach/service";
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
  // Claude errors only reach here when there's no OpenAI fallback (or it failed too)
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.";
  if (err instanceof Anthropic.RateLimitError) return "The coach is rate-limited or out of API credit right now. Check your Anthropic billing, or try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Try again.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API returned an error (${err.status ?? "unknown"}). Try again.`;
  if (err instanceof OpenAI.AuthenticationError) return "The OpenAI API key was rejected. Check OPENAI_API_KEY in Vercel.";
  if (err instanceof OpenAI.RateLimitError) return "The coach is rate-limited or out of API credit right now. Check your OpenAI billing, or try again in a minute.";
  if (err instanceof OpenAI.APIConnectionError) return "Couldn't reach the OpenAI API. Try again.";
  if (err instanceof OpenAI.APIError) return `The OpenAI API returned an error (${err.status ?? "unknown"}). Try again.`;
  return "Something went wrong while the coach was answering. Try again.";
}

/** Heartbeat while the coach thinks or runs tools: mobile networks drop connections that go quiet. */
const PING_MS = 8000;

/**
 * The stored transcript of a conversation, and whether a reply is still being
 * written. The chat uses it to recover a reply whose stream was cut off (the
 * phone locked, the app went to the background, the network dropped): the turn
 * keeps running on the server and is stored either way.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = z.string().uuid().safeParse(request.nextUrl.searchParams.get("c"));
  if (!id.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const db = createAdminClient();
  const [turns, inProgress] = await Promise.all([loadTranscript(db, user.id, id.data), turnInProgress(db, user.id, id.data)]);
  return NextResponse.json({ turns, inProgress }, { headers: { "Cache-Control": "no-store" } });
}

/** Streams the coach's answer as newline-delimited JSON events. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!coachConfigured()) return NextResponse.json({ error: "The coach needs ANTHROPIC_API_KEY (or OPENAI_API_KEY) to be set in Vercel." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const timezone = await userTimezone();
  const today = todayIn(timezone);
  const db = createAdminClient();
  const context = parsed.data.activityId ? await checkinContext(db, user.id, parsed.data.activityId).catch(() => null) : null;
  const encoder = new TextEncoder();

  let finished!: () => void;
  // keep the function alive until the turn is stored, even if the browser disconnects
  after(new Promise<void>((resolve) => (finished = resolve)));

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (line: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // the browser went away; the turn still finishes and is stored
          open = false;
        }
      };
      const send = (e: CoachEvent) => write(`${JSON.stringify(e)}\n`);
      const ping = setInterval(() => write(`{"type":"ping"}\n`), PING_MS);
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
        clearInterval(ping);
        if (changed) {
          revalidatePath("/plan", "layout");
          revalidatePath("/routes", "layout");
          revalidatePath("/activities", "layout");
          revalidatePath("/");
        }
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by a disconnect
          }
        }
        finished();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
