"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import clsx from "clsx";

interface Job {
  id: string;
  kind: string;
  status: string;
  range_start: string | null;
  discovered: number;
  processed: number;
  failed: number;
  unavailable: number;
  skipped: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

const ACTIVE = ["queued", "discovering", "processing"];

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}

export function SyncPanel({ initialJobs }: { initialJobs: Job[] }) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(defaultFrom);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/sync", { cache: "no-store" });
    if (r.ok) setJobs((await r.json()).jobs);
  }, []);

  /** Drives ticks from the browser while a job is active, so imports proceed faster than the scheduler. */
  const drive = useCallback(
    async (first: object) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      try {
        let body: object = first;
        let transient = 0;
        for (let i = 0; i < 200; i++) {
          let r: Response | null = null;
          try {
            r = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          } catch {
            r = null; // offline / connection dropped
          }
          // A timed-out or dropped tick loses nothing (state is in the database):
          // wait and carry on instead of abandoning a long import.
          if (!r || r.status >= 500) {
            if (++transient > 3) throw new Error("Garmin sync keeps timing out. It will continue in the background; try again later.");
            await new Promise((res) => setTimeout(res, 2000 * 2 ** transient));
            body = { action: "continue" };
            continue;
          }
          transient = 0;
          const j = await r.json().catch(() => ({}));
          await refresh();
          if (!r.ok) throw new Error(j.error ?? `Sync failed (HTTP ${r.status})`);
          if (j.authError) throw new Error(j.authError);
          if (j.error) throw new Error(j.error);
          if (j.done) break;
          body = { action: "continue" };
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );

  const active = jobs.find((j) => ACTIVE.includes(j.status));
  useEffect(() => {
    if (active && !running.current) void drive({ action: "continue" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div className="card p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="section-title">Sync now</p>
            <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">Fetches new runs since your latest import. Runs automatically every 30 minutes.</p>
          </div>
          <button onClick={() => drive({ action: "sync" })} disabled={busy} className="btn btn-secondary shrink-0">
            <RefreshCw size={16} className={clsx(busy && "animate-spin")} />
            {busy ? "Syncing" : "Sync"}
          </button>
        </div>
      </div>

      <div className="card p-5">
        <p className="section-title">Import history</p>
        <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
          Import at least 12–16 weeks; 6–12 months gives a much better baseline. Re-importing is safe: runs already imported are skipped.
        </p>
        <div className="mt-4 flex gap-2">
          <input
            type="date"
            value={from}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setFrom(e.target.value)}
            className="input min-w-0 flex-1"
          />
          <button
            onClick={() => drive({ action: "historical", from })}
            disabled={busy || !from}
            className="btn btn-primary min-h-12 shrink-0"
          >
            Import
          </button>
        </div>
      </div>

      {error && <p className="rounded-2xl bg-danger/10 p-4 text-sm ring-1 ring-danger/25 ring-inset">{error}</p>}

      {jobs.length > 0 && (
        <div className="card divide-hairline overflow-hidden">
          {jobs.map((j) => {
            const pending = Math.max(0, j.discovered - j.processed - j.failed - j.unavailable - j.skipped);
            const pct = j.discovered ? Math.round(((j.discovered - pending) / j.discovered) * 100) : 0;
            return (
              <div key={j.id} className="p-4 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold capitalize">
                    {j.kind} sync{j.range_start ? ` from ${j.range_start}` : ""}
                  </span>
                  <span className={clsx("text-xs font-medium capitalize", ACTIVE.includes(j.status) ? "text-accent" : j.status === "failed" ? "text-danger" : j.status === "done" ? "text-good" : "text-muted")}>
                    {j.status}
                  </span>
                </div>
                {ACTIVE.includes(j.status) && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${j.status === "discovering" ? 5 : pct}%` }} />
                  </div>
                )}
                <p className="tabular mt-1.5 text-xs leading-snug text-muted">
                  {j.discovered} found · {j.processed} imported · {j.skipped} skipped (not runs / duplicates) · {j.unavailable} unavailable · {j.failed} failed
                  {pending > 0 && ` · ${pending} pending`}
                </p>
                {j.last_error && <p className="mt-1 text-xs text-danger">{j.last_error}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
