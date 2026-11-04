"use client";

import { useActionState } from "react";
import { Download, Watch } from "lucide-react";
import { Badge } from "@/components/ui";
import { WATCH_STATE } from "@/components/watch/states";
import { watchAction, type WatchState } from "./watch-actions";

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
          <p className="text-sm leading-relaxed text-muted">{st ? st.detail : sendable ? "Not sent yet. Workouts in the next two weeks are sent automatically when Løype syncs." : "Only upcoming runs are sent to the watch."}</p>
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
            <p className="text-xs leading-snug text-warn">Sent with heart-rate targets because Intervals.icu has no Run threshold pace. Set one there to get pace targets on the watch.</p>
          )}
          <form action={action} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={id} />
            {sendable && (
              <button name="op" value="send" disabled={pending} className="btn btn-secondary btn-sm">
                {pending ? "Sending…" : sync && sync.state !== "removed" ? "Send again" : "Send now"}
              </button>
            )}
            {delivered && sync.state !== "on_watch" && (
              <button name="op" value="confirm" disabled={pending} className="btn btn-secondary btn-sm">
                I see it on my watch
              </button>
            )}
            {sync?.state === "on_watch" && (
              <button name="op" value="unconfirm" disabled={pending} className="btn btn-secondary btn-sm">
                It&apos;s not there
              </button>
            )}
          </form>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-muted">
          Connect Intervals.icu under{" "}
          <a href="/more/integrations" className="font-medium text-accent underline underline-offset-2">
            More → Integrations
          </a>{" "}
          to send workouts to Garmin Connect automatically, or download the file below.
        </p>
      )}

      <div className="border-t border-[var(--hairline)] pt-4">
        <a href={`/api/workouts/${id}/fit`} download className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          <Download size={15} /> Download .FIT workout
        </a>
        <p className="mt-1 text-xs leading-relaxed text-muted">Manual fallback: connect the watch by USB and copy the file into its GARMIN/NewFiles folder. Pace steps carry pace targets, other steps heart rate.</p>
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-good">Updated.</p>}
    </section>
  );
}
