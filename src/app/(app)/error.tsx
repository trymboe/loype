"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

/** Friendly failure screen (e.g. database unreachable) with a retry, instead of the bare Next.js error page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
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
