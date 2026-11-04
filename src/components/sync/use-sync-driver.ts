"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SyncJob {
  id: string;
  kind: string;
  provider?: string | null;
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

export const ACTIVE_JOB = ["queued", "discovering", "processing"];

/**
 * Drives sync ticks from the browser while a job is active, so imports
 * proceed faster than the background scheduler. Resumes an active job on mount.
 */
export function useSyncDriver(initialJobs: SyncJob[], onDone?: () => void) {
  const [jobs, setJobs] = useState<SyncJob[]>(initialJobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/sync", { cache: "no-store" });
    if (r.ok) setJobs((await r.json()).jobs);
  }, []);

  const drive = useCallback(
    async (first: object) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      let finished = false;
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
          if (j.done) {
            finished = true;
            break;
          }
          body = { action: "continue" };
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        running.current = false;
        setBusy(false);
      }
      if (finished) onDone?.();
    },
    [refresh, onDone],
  );

  const active = jobs.find((j) => ACTIVE_JOB.includes(j.status));
  useEffect(() => {
    if (active && !running.current) void drive({ action: "continue" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { jobs, busy, error, drive, active };
}
