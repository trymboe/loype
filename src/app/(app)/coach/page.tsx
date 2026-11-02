import Link from "next/link";
import { History, KeyRound, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { CoachChat } from "@/components/coach/chat";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { coachConfigured, listConversations, loadProposals, loadTranscript } from "@/lib/coach/service";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { relativeDay, todayIn } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";

export const metadata = { title: "Coach" };
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function CoachPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await getSessionUser();
  if (!user) return null;
  if (!coachConfigured()) return <NeedsKey />;

  const { c } = await searchParams;
  const db = createAdminClient();
  const today = todayIn(await userTimezone());
  const conversations = await listConversations(db, user.id);
  const current = c && /^[0-9a-f-]{36}$/i.test(c) ? (conversations.find((x) => x.id === c) ?? null) : null;
  const turns = current ? await loadTranscript(db, user.id, current.id) : [];
  const proposals = await loadProposals(db, user.id, turns.flatMap((t) => t.proposalIds));
  const suggestions = current ? [] : await suggestionsFor(db, user.id);

  return (
    <>
      <PageHeader
        title="Coach"
        subtitle={current ? current.title : "Answers from your own runs, fitness and plan"}
        action={
          <div className="flex shrink-0 gap-2">
            {conversations.length > 0 && (
              <details className="group relative">
                <summary className="btn btn-secondary btn-sm list-none [&::-webkit-details-marker]:hidden" aria-label="Past conversations">
                  <History size={16} />
                </summary>
                <div className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-2xl border border-[var(--hairline)] bg-surface shadow-[var(--shadow-pop)]">
                  <p className="label px-4 pt-3 pb-1">Past conversations</p>
                  <ul className="max-h-80 divide-y divide-[var(--hairline)] overflow-y-auto">
                    {conversations.map((x) => (
                      <li key={x.id}>
                        <Link href={`/coach?c=${x.id}`} className="block px-4 py-2.5 hover:bg-surface-2" aria-current={x.id === current?.id ? "page" : undefined}>
                          <span className="line-clamp-1 text-sm font-medium">{x.title}</span>
                          <span className="text-xs text-subtle">{relativeDay(x.updated_at.slice(0, 10), today)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            )}
            {current && (
              <Link href="/coach" className="btn btn-secondary btn-sm" aria-label="New conversation">
                <Plus size={16} /> New
              </Link>
            )}
          </div>
        }
      />
      <CoachChat key={current?.id ?? "new"} conversationId={current?.id ?? null} turns={turns} proposals={proposals} suggestions={suggestions} />
    </>
  );
}

/** Starter questions that fit what the athlete actually has. */
async function suggestionsFor(db: ReturnType<typeof createAdminClient>, userId: string): Promise<string[]> {
  const [{ data: plan }, { data: lastRun }] = await Promise.all([
    db.from("training_plans").select("config, goal:goals(kind, name, distance_m, target_time_s, race_date)").eq("user_id", userId).eq("status", "active").maybeSingle(),
    db.from("activities").select("id").eq("user_id", userId).eq("sport", "running").is("duplicate_of", null).order("start_time", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const out: string[] = [];
  const goal = (plan as any)?.goal;
  if (goal?.target_time_s && goal?.distance_m) {
    const dist = goal.distance_m === 21_097.5 ? "half marathon" : goal.distance_m === 42_195 ? "marathon" : `${Math.round(goal.distance_m / 100) / 10} km`;
    out.push(`Am I on track for a ${fmtTime(goal.target_time_s)} ${dist}?`);
  }
  if (lastRun) out.push("What does my last run tell you?");
  out.push("Am I improving, even if my VO2max estimate hasn't moved?");
  out.push("Compare my current form with three months ago.");
  if (plan) {
    out.push("I'm tired today. Can we adapt my week?");
    out.push("Why does my plan have so many easy runs?");
    if ((plan as any).config?.includeIntervals) out.push("Should I run my intervals faster?");
  } else out.push("What should I focus on next?");
  return out.slice(0, 6);
}

function NeedsKey() {
  return (
    <>
      <PageHeader title="Coach" />
      <div className="card rise p-6">
        <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <KeyRound size={20} />
        </div>
        <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Add a Claude API key to turn on the coach</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          The coach answers questions using your runs, fitness estimates and plan, and can suggest plan changes for you to accept or keep. It runs on the Claude API, which needs a key stored on the server.
        </p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-fg-2 marker:text-subtle">
          <li>
            Create a key at{" "}
            <a className="font-medium text-accent" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            .
          </li>
          <li>
            In Vercel, add it to the project as <code className="rounded bg-surface-2 px-1">ANTHROPIC_API_KEY</code> (Production, sensitive).
          </li>
          <li>Redeploy, then come back here.</li>
        </ol>
      </div>
    </>
  );
}
