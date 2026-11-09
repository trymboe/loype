"use client";

import { useActionState } from "react";
import { Download, Watch } from "lucide-react";
import { Badge } from "@/components/ui";
import { WATCH_STATE } from "@/components/watch/states";
import { watchAction, type WatchState } from "./watch-actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export interface WatchSync {
  state: string;
  last_error: string | null;
  last_sent_at: string | null;
  target_mode: string | null;
  parse_check: { ok: boolean; problems: string[] } | null;
}

export function WatchCard({ id, sync, connected, sendable, thresholdMissing }: { id: string; sync: WatchSync | null; connected: boolean; sendable: boolean; thresholdMissing: boolean }) {
  const [state, action, pending] = useActionState<WatchState, FormData>(watchAction, {});
  const st = sync ? (WATCH_STATE[sync.state] ?? WATCH_STATE.pending) : null;
  const delivered = sync && ["sent", "parsed", "mismatch", "on_watch"].includes(sync.state);
  return (
    <section className="card rise space-y-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="section-title flex items-center gap-2">
          <Watch size={17} className="text-muted" /> On your watch
        </h2>
        {st && <Badge tone={st.tone}>{st.label}</Badge>}
      </div>

      {connected ? (
        <>
          {sync?.parse_check && !sync.parse_check.ok && (
            <ul className="space-y-1">
              {sync.parse_check.problems.map((p, i) => (
                <li key={i} className="rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
                  {p}
                </li>
              ))}
            </ul>
          )}
          {sync?.state === "failed" && sync.last_error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs leading-snug text-danger">{sync.last_error}</p>}
          {sync?.target_mode === "HR" && thresholdMissing && (
            <p className="text-xs leading-snug text-warn">Sent with heart-rate targets: Intervals.icu has no Run threshold pace.</p>
          )}
          <form action={action} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={id} />
            {sendable && (
              <SubmitButton name="op" value="send" disabled={pending} className="btn btn-secondary btn-sm">
                {pending ? "Sending…" : sync && sync.state !== "removed" ? "Send again" : "Send now"}
              </SubmitButton>
            )}
            {delivered && sync.state !== "on_watch" && (
              <SubmitButton name="op" value="confirm" disabled={pending} className="btn btn-secondary btn-sm">
                I see it on my watch
              </SubmitButton>
            )}
            {sync?.state === "on_watch" && (
              <SubmitButton name="op" value="unconfirm" disabled={pending} className="btn btn-secondary btn-sm">
                It&apos;s not there
              </SubmitButton>
            )}
          </form>
        </>
      ) : (
        <a href="/more/integrations" className="btn btn-secondary btn-sm">
          Connect Intervals.icu
        </a>
      )}

      <div className="border-t border-[var(--hairline)] pt-4">
        <a href={`/api/workouts/${id}/fit`} download className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          <Download size={15} /> Download .FIT workout
        </a>
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-good">Updated.</p>}
    </section>
  );
}
