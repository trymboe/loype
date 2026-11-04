"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";

/** Friendly failure screen (e.g. database unreachable) with a retry, instead of the bare Next.js error page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleBuildError(error);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    console.error(error);
    if (stale && reloadForNewBuild()) setReloading(true);
  }, [error, stale]);
  if (stale) {
    return (
      <div className="card rise mt-8 p-6">
        <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <RefreshCw size={20} className={reloading ? "animate-spin" : undefined} />
        </div>
        <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Løype was just updated</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{reloading ? "Loading the new version…" : "Reload to get the new version, then check whether your last change went through."}</p>
        {!reloading && (
          <button onClick={() => window.location.reload()} className="btn btn-primary mt-5">
            Reload
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="card rise mt-8 p-6">
      <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-warn/12 text-warn">
        <AlertTriangle size={20} />
      </div>
      <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Something went wrong loading this page</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Your data is safe. This is usually a temporary connection problem.{error.digest && <span className="mt-1 block text-xs text-subtle">Reference: {error.digest}</span>}
      </p>
      <button onClick={reset} className="btn btn-primary mt-5">
        Try again
      </button>
    </div>
  );
}
