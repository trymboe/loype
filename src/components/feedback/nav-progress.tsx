"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

type Phase = "idle" | "loading" | "done";

const starts = new Set<() => void>();
const holdListeners = new Set<(n: number) => void>();
let holds = 0;

/** Start the top loading bar by hand, e.g. right before a `router.push`. */
export function startNavProgress() {
  starts.forEach((l) => l());
}

/**
 * Keep the bar running while a loading screen is up (the URL has already
 * changed by then, but the content hasn't arrived). Returns the release.
 */
export function holdNavProgress(): () => void {
  holds++;
  holdListeners.forEach((l) => l(holds));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    holdListeners.forEach((l) => l(holds));
  };
}

/** True when going to `href` changes the screen (not just the #hash). */
export function changesScreen(href: string): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return false;
  return url.pathname !== location.pathname || url.search !== location.search;
}

/**
 * Global tap feedback.
 * - A thin accent bar along the top appears the instant an in-app link is
 *   tapped (see `@/components/link`) and finishes when the new screen is in
 *   place, so a slow server round-trip never looks like a missed tap. Covers
 *   search-param changes too, which don't show the route's loading skeleton.
 * - Registers a no-op touchstart listener, which is what makes iOS Safari apply
 *   `:active` styles, so pressed states actually show on the phone.
 */
export function NavProgress() {
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}

function Bar() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = `${pathname}?${search}`;
  // URL the tap happened on; the bar runs until we've left it
  const [startedOn, setStartedOn] = useState<string | null>(null);
  const [held, setHeld] = useState(holds > 0);
  const [phase, setPhase] = useState<Phase>("idle");
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      setStartedOn(keyRef.current);
      clearTimeout(timeout);
      // never leave a bar stuck if a navigation is abandoned
      timeout = setTimeout(() => setStartedOn(null), 12_000);
    };
    const onHold = (n: number) => setHeld(n > 0);
    const noop = () => {};
    starts.add(start);
    holdListeners.add(onHold);
    document.addEventListener("touchstart", noop, { passive: true });
    window.addEventListener("popstate", start);
    return () => {
      starts.delete(start);
      holdListeners.delete(onHold);
      document.removeEventListener("touchstart", noop);
      window.removeEventListener("popstate", start);
      clearTimeout(timeout);
    };
  }, []);

  // Arrived somewhere new: the tap's job is done (a loading screen may still hold the bar).
  useEffect(() => {
    if (startedOn !== null && startedOn !== key) setStartedOn(null);
  }, [key, startedOn]);

  const loading = (startedOn !== null && startedOn === key) || held;
  useEffect(() => {
    if (loading) {
      setPhase("loading");
      return;
    }
    setPhase((p) => (p === "loading" ? "done" : p));
    const t = setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 450);
    return () => clearTimeout(t);
  }, [loading]);

  if (phase === "idle") return null;
  return (
    <div className="nav-progress" role="progressbar" aria-label="Loading" aria-busy={phase === "loading"}>
      <span
        style={
          phase === "loading"
            ? { animation: "nav-progress-trickle 12s cubic-bezier(0.1, 0.8, 0.2, 1) both" }
            : { transform: "scaleX(1)", opacity: 0, transition: "transform 0.2s ease-out, opacity 0.3s 0.15s" }
        }
      />
    </div>
  );
}
