import clsx from "clsx";
import { ACTIVE_JOB as ACTIVE, type SyncJob } from "./use-sync-driver";

/** Recent sync jobs with progress and retrieved / processed / failed / unavailable counts. */
export function JobList({ jobs }: { jobs: SyncJob[] }) {
  if (!jobs.length) return null;
  return (
    <div className="card divide-hairline overflow-hidden">
      {jobs.map((j) => {
        const pending = Math.max(0, j.discovered - j.processed - j.failed - j.unavailable - j.skipped);
        const pct = j.discovered ? Math.round(((j.discovered - pending) / j.discovered) * 100) : 0;
        return (
          <div key={j.id} className="p-4 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold capitalize">
                {j.provider === "strava" ? "Strava · " : j.provider === "garmin" ? "Garmin · " : ""}
                {j.kind} sync{j.range_start ? ` from ${j.range_start}` : ""}
              </span>
              <span className={clsx("text-xs font-medium capitalize", ACTIVE.includes(j.status) ? "text-accent" : j.status === "failed" ? "text-danger" : j.status === "completed" ? "text-good" : "text-muted")}>
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
  );
}
