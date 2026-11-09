"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/link";
import { CalendarDays, Check, Map as MapIcon, Activity, Undo2 } from "lucide-react";
import { undoCoachAction } from "@/app/(app)/coach/actions";

export interface Change {
  kind: "plan" | "route" | "run";
  summary: string;
}

const ICON = { plan: CalendarDays, route: MapIcon, run: Activity };

/** What the coach changed in one reply, with Undo for the plan changes. */
export function ChangesCard({ changes, messageIds, undone: initiallyUndone, busy }: { changes: Change[]; messageIds: string[]; undone: boolean; busy: boolean }) {
  const [undone, setUndone] = useState(initiallyUndone);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const planChanges = changes.some((c) => c.kind === "plan");

  return (
    <div className="card rise overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
        <p className="label flex items-center gap-1.5">
          <Check size={14} className="text-good" /> {undone ? "Changes undone" : "Changed for you"}
        </p>
        {planChanges && !undone && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pending || busy}
            aria-busy={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await undoCoachAction(messageIds);
                if (r.error) setError(r.error);
                else {
                  setUndone(true);
                  router.refresh();
                }
              })
            }
          >
            {!pending && <Undo2 size={15} />} {pending ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
      <ul className="space-y-2 px-4 pt-2.5 pb-3.5">
        {changes.map((c, i) => {
          const Icon = ICON[c.kind] ?? CalendarDays;
          return (
            <li key={i} className={`flex gap-2.5 text-sm leading-snug ${undone && c.kind === "plan" ? "text-subtle line-through" : "text-fg-2"}`}>
              <Icon size={16} className="mt-px shrink-0 text-muted" />
              <span>{c.summary}</span>
            </li>
          );
        })}
      </ul>
      {planChanges && (
        <Link href="/plan" className="block border-t border-[var(--hairline)] px-4 py-2.5 text-sm font-medium text-accent">
          See your plan
        </Link>
      )}
      {error && <p className="px-4 pb-3 text-sm text-danger">{error}</p>}
    </div>
  );
}
