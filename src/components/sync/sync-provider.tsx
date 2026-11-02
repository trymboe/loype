"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { NewRunReveal, type RevealRun } from "./new-run-reveal";

type Phase = "idle" | "syncing" | "error";

interface SyncState {
  phase: Phase;
  lastSyncedAt: string | null;
  error: string | null;
  connected: boolean;
  sync: () => void;
}

const SyncContext = createContext<SyncState | null>(null);

export function useSync(): SyncState {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync outside SyncProvider");
  return ctx;
}

/** Auto-sync at most this often when the app opens or comes back to the foreground. */
const AUTO_INTERVAL_MS = 5 * 60_000;
const MAX_TICKS = 12;
const LAST_AUTO_KEY = "loype.lastAutoSync";
const CURSOR_KEY = "loype.revealCursor";

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // private mode / storage blocked: auto-sync still works, it just isn't throttled across reloads
  }
  return null;
}

/**
 * Owns Garmin syncing for the whole app: syncs when the app opens or regains focus,
 * offers pull-to-refresh, and reveals runs that arrived since the last visit.
 */
export function SyncProvider({
  children,
  connected,
  initialLastSyncedAt,
}: {
  children: ReactNode;
  connected: boolean;
  initialLastSyncedAt: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(initialLastSyncedAt);
  const [reveal, setReveal] = useState<RevealRun[]>([]);
  const running = useRef(false);

  /** Shows runs imported since the last time this device looked (by us or by the scheduled sync). */
  const checkNew = useCallback(async (opts: { latest?: boolean } = {}) => {
    const prev = store(CURSOR_KEY);
    const qs = opts.latest ? "latest=1" : prev ? `after=${encodeURIComponent(prev)}` : "";
    const r = await fetch(`/api/activities/new?${qs}`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as { cursor: string | null; runs: RevealRun[] };
    if (j.cursor && !opts.latest) store(CURSOR_KEY, j.cursor);
    if (j.runs.length) setReveal(j.runs);
  }, []);

  const sync = useCallback(async () => {
    if (running.current || !connected) return;
    running.current = true;
    setPhase("syncing");
    setError(null);
    store(LAST_AUTO_KEY, String(Date.now()));
    let imported = 0;
    try {
      let body: object = { action: "sync" };
      for (let i = 0; i < MAX_TICKS; i++) {
        const r = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `Sync failed (HTTP ${r.status})`);
        if (j.authError) throw new Error("Garmin rejected your API key");
        if (j.error) throw new Error(j.error);
        imported += j.processed ?? 0;
        if (j.done) break;
        body = { action: "continue" };
      }
      setLastSyncedAt(new Date().toISOString());
      setPhase("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
      setPhase("error");
    } finally {
      running.current = false;
    }
    await checkNew();
    if (imported > 0) router.refresh();
  }, [connected, checkNew, router]);

  // Open + return to foreground. iOS home-screen apps resume rather than reload, so focus matters most.
  useEffect(() => {
    const maybe = () => {
      if (document.visibilityState !== "visible") return;
      const last = Number(store(LAST_AUTO_KEY) ?? 0);
      if (connected && Date.now() - last > AUTO_INTERVAL_MS) void sync();
      else void checkNew();
    };
    maybe();
    document.addEventListener("visibilitychange", maybe);
    window.addEventListener("pageshow", maybe);
    return () => {
      document.removeEventListener("visibilitychange", maybe);
      window.removeEventListener("pageshow", maybe);
    };
  }, [connected, sync, checkNew]);

  // ?reveal=latest replays the reveal for the most recent run
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reveal") === "latest") void checkNew({ latest: true });
  }, [checkNew]);

  const pull = usePullToRefresh(sync, connected && phase !== "syncing");

  return (
    <SyncContext.Provider value={{ phase, lastSyncedAt, error, connected, sync }}>
      <PullIndicator distance={pull} syncing={phase === "syncing"} />
      {children}
      {reveal.length > 0 && <NewRunReveal runs={reveal} onClose={() => setReveal([])} />}
    </SyncContext.Provider>
  );
}

const PULL_TRIGGER = 72;

/** Pull down at the top of any page to sync (standalone iOS apps have no built-in pull-to-refresh). */
function usePullToRefresh(onTrigger: () => void, enabled: boolean): number {
  const [dist, setDist] = useState(0);
  const start = useRef<number | null>(null);
  const cur = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setDist(0);
      return;
    }
    const down = (e: TouchEvent) => {
      start.current = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    };
    const move = (e: TouchEvent) => {
      if (start.current == null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) {
        cur.current = 0;
        setDist(0);
        return;
      }
      cur.current = Math.min(120, dy * 0.5);
      setDist(cur.current);
    };
    const up = () => {
      if (start.current != null && cur.current >= PULL_TRIGGER) onTrigger();
      start.current = null;
      cur.current = 0;
      setDist(0);
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [enabled, onTrigger]);
  return dist;
}

function PullIndicator({ distance, syncing }: { distance: number; syncing: boolean }) {
  const visible = distance > 8 || syncing;
  const ready = distance >= PULL_TRIGGER;
  const y = syncing ? 12 : Math.min(distance, PULL_TRIGGER) - 28;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 flex justify-center transition-opacity md:hidden"
      style={{ opacity: visible ? 1 : 0, transform: `translateY(${y}px)`, transition: distance ? "opacity 150ms" : "transform 250ms, opacity 250ms" }}
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-surface shadow-lg ring-1 ring-[var(--hairline)]">
        <RefreshCw
          size={17}
          className={syncing ? "animate-spin text-accent" : ready ? "text-accent" : "text-muted"}
          style={syncing ? undefined : { transform: `rotate(${distance * 3}deg)` }}
        />
      </span>
    </div>
  );
}
