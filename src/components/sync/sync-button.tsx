"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { relativeTime } from "@/lib/dates";
import { useSync } from "./sync-provider";

/** Sync status pill: shows when runs last synced and syncs on tap. */
export function SyncButton({ className }: { className?: string }) {
  const { phase, lastSyncedAt, connected, error, sync } = useSync();
  // re-render every half minute so "Synced 2m ago" stays true
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!connected) return null;
  const syncing = phase === "syncing";
  const failed = phase === "error";
  const label = syncing ? "Syncing…" : failed ? "Sync failed · retry" : lastSyncedAt ? `Synced ${relativeTime(lastSyncedAt)}` : "Sync now";
  return (
    <button
      type="button"
      onClick={sync}
      disabled={syncing}
      title={failed && error ? error : "Sync runs"}
      className={clsx(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 pr-3.5 pl-3 text-xs font-medium transition-colors active:scale-[0.97] disabled:opacity-100",
        failed ? "text-warn" : "text-muted hover:text-fg",
        className,
      )}
    >
      {failed ? <AlertTriangle size={14} /> : <RefreshCw size={14} className={clsx(syncing && "animate-spin text-accent")} />}
      <span aria-live="polite" suppressHydrationWarning>
        {label}
      </span>
    </button>
  );
}
