"use client";

import { useEffect, useState } from "react";
import Link from "@/components/link";
import { MessageCircle, Sparkles } from "lucide-react";

/**
 * The coach's check-in on a key session. Fetched after the page has rendered
 * (it may have to be written first), and again when the feedback changes.
 * Shows nothing when there is no check-in.
 */
export function CoachCheckin({ activityId, feedbackKey }: { activityId: string; feedbackKey: string }) {
  // undefined while loading, null when there is none
  const [text, setText] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/activities/${activityId}/checkin`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : { text: null }))
      .catch(() => ({ text: null }))
      .then((b: { text?: string | null }) => {
        if (live) setText(b.text ?? null);
      });
    return () => {
      live = false;
    };
  }, [activityId, feedbackKey]);

  // after a feedback change the previous text stays until the new one is written
  if (text === undefined) {
    return (
      <section className="card mb-3 flex gap-3 p-4" aria-busy="true">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex-1 space-y-2 py-0.5">
          <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
        </div>
      </section>
    );
  }
  if (!text) return null;
  return (
    <Link href={`/coach?run=${activityId}`} className="card rise mb-3 flex gap-3 p-4 transition hover:bg-surface-2/40">
      <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
      <p className="flex-1 text-[0.9375rem] leading-relaxed text-fg-2">{text}</p>
      <MessageCircle size={16} className="mt-0.5 shrink-0 text-muted" aria-label="Ask the coach" />
    </Link>
  );
}
