"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import clsx from "clsx";
import { JobList } from "@/components/sync/job-list";
import { useSyncDriver, type SyncJob as Job } from "@/components/sync/use-sync-driver";

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}

export function SyncPanel({ initialJobs }: { initialJobs: Job[] }) {
  const { jobs, busy, error, drive } = useSyncDriver(initialJobs);
  const [from, setFrom] = useState(defaultFrom);

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

      <JobList jobs={jobs} />
    </div>
  );
}
