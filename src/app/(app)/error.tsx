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
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle size={18} className="text-warn" /> Something went wrong loading this page
      </div>
      <p className="mt-1 text-sm text-muted">
        Your data is safe. This is usually a temporary connection problem.{error.digest && <span className="block text-xs">Reference: {error.digest}</span>}
      </p>
      <button onClick={reset} className="mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg">
        Try again
      </button>
    </div>
  );
}
