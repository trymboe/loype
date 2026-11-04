"use client";

import { useEffect, useState } from "react";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";
import "./globals.css";

/**
 * Last-resort boundary for errors outside the app's own error screen (the root
 * layout). Replaces Next.js's bare "Application error" page. A new deployment
 * clashing with an already-open app is the common cause: reload once.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const stale = isStaleBuildError(error);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    console.error(error);
    if (stale && reloadForNewBuild()) setReloading(true);
  }, [error, stale]);
  return (
    <html lang="en">
      <body className="antialiased">
        <main className="mx-auto max-w-md px-5 pt-24">
          <div className="card p-6">
            <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">{stale ? "Løype was just updated" : "Something went wrong"}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {reloading ? "Loading the new version…" : stale ? "Reload to get the new version, then check whether your last change went through." : "Your data is safe. Reload to continue."}
              {error.digest && <span className="mt-1 block text-xs">Reference: {error.digest}</span>}
            </p>
            {!reloading && (
              <button onClick={() => window.location.reload()} className="btn btn-primary mt-5">
                Reload
              </button>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
