"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { JobList } from "@/components/sync/job-list";
import { useSyncDriver, type SyncJob } from "@/components/sync/use-sync-driver";

const CHOICES = [
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
  { months: 24, label: "2 years" },
];

function monthsAgo(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function ImportStep({ initialJobs }: { initialJobs: SyncJob[] }) {
  const router = useRouter();
  const onDone = useCallback(() => router.refresh(), [router]);
  const { jobs, busy, error, drive, active } = useSyncDriver(initialJobs, onDone);
  const [months, setMonths] = useState(12);
  const [custom, setCustom] = useState("");
  const from = custom || monthsAgo(months);
  const running = busy || !!active;

  return (
    <div className="space-y-3">
      <div className="card p-5">
        <p className="section-title">How far back?</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CHOICES.map((c) => (
            <button
              key={c.months}
              type="button"
              disabled={running}
              onClick={() => {
                setMonths(c.months);
                setCustom("");
              }}
              className={clsx(
                "rounded-2xl p-3 text-left ring-inset transition-all",
                !custom && months === c.months ? "bg-accent/10 ring-2 ring-accent" : "bg-surface-2 ring-1 ring-transparent hover:bg-surface-3",
              )}
            >
              <span className="block text-sm font-semibold">{c.label}</span>
            </button>
          ))}
        </div>
        <label className="mt-3 block text-xs text-muted">
          Or from a date
          <input
            type="date"
            value={custom}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setCustom(e.target.value)}
            disabled={running}
            className="input mt-1"
          />
        </label>
        <button onClick={() => drive({ action: "historical", from })} disabled={running} className="btn btn-primary btn-block mt-4 min-h-12">
          {running ? "Importing…" : `Import from ${from}`}
        </button>
      </div>
      {error && <p className="rounded-2xl bg-danger/10 p-4 text-sm ring-1 ring-danger/25 ring-inset">{error}</p>}
      <JobList jobs={jobs} />
    </div>
  );
}
