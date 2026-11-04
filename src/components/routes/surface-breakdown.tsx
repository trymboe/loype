"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LngLat } from "@/lib/routes/geometry";
import { SURFACE_CLASSES, SURFACE_COLOR, SURFACE_LABEL, surfacePercents, type SurfaceSummary } from "@/lib/routes/surface";

export type SurfaceState = "idle" | "loading" | "failed";

/**
 * Looks up the surface along a line, debounced. `key` should change only when
 * the geometry really changes (pass null to skip, e.g. while routing is pending).
 */
export function useSurfaces(coords: LngLat[], key: string | null, { gps = false, delayMs = 900 } = {}) {
  const [data, setData] = useState<SurfaceSummary | null>(null);
  const [state, setState] = useState<SurfaceState>("idle");
  useEffect(() => {
    setData(null);
    if (!key || coords.length < 2) {
      setState("idle");
      return;
    }
    setState("loading");
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/routes/surface", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ coords, gps }),
        });
        if (!res.ok) throw new Error();
        const json = (await res.json()) as SurfaceSummary;
        if (!cancelled) {
          setData(json);
          setState("idle");
        }
      } catch {
        if (!cancelled) setState("failed");
      }
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, state };
}

/** Share of the route per surface type, with the soft (gravel + trail) share up front. */
export function SurfaceBreakdown({
  data,
  state,
  onMap,
  onToggleMap,
}: {
  data: SurfaceSummary | null;
  state: SurfaceState;
  onMap?: boolean;
  onToggleMap?: (v: boolean) => void;
}) {
  if (state === "idle" && !data) return null;
  if (state === "failed") return <p className="px-1 text-xs text-muted">Surface info is unavailable right now.</p>;
  if (!data) {
    return (
      <section className="card flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> Checking surfaces…
      </section>
    );
  }
  if (data.totalM <= 0) return null;
  const pct = surfacePercents(data.metres);
  const shown = SURFACE_CLASSES.filter((c) => data.metres[c] > 0);
  const soft = data.softPct;
  return (
    <section className="card p-4" aria-label="Surface">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.6875rem] font-semibold text-fg-2">Surface</span>
        {soft != null && (
          <span className="text-sm">
            <span className="display tabular text-[1.125rem]">{Math.round(soft)}%</span> <span className="text-muted">soft</span>
          </span>
        )}
      </div>
      <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={shown.map((c) => `${SURFACE_LABEL[c]} ${pct[c]}%`).join(", ")}>
        {shown.map((c) => (
          <div key={c} style={{ width: `${(data.metres[c] / data.totalM) * 100}%`, background: SURFACE_COLOR[c] }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-2">
        {shown.map((c) => (
          <li key={c} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: SURFACE_COLOR[c] }} />
            <span className="min-w-0 flex-1 truncate text-fg-2">{SURFACE_LABEL[c]}</span>
            <span className="tabular text-muted">
              {pct[c]}% · {(data.metres[c] / 1000).toFixed(1)} km
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.6875rem] text-subtle">Estimated from OpenStreetMap. Soft = gravel and dirt or trail.</p>
        {onToggleMap && (
          <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-muted">
            <input type="checkbox" className="switch" checked={!!onMap} onChange={(e) => onToggleMap(e.target.checked)} />
            Colour map by surface
          </label>
        )}
      </div>
    </section>
  );
}
