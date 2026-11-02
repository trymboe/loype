"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarCheck, Flame, Timer, Trophy, X } from "lucide-react";
import clsx from "clsx";
import { RevealMap } from "./reveal-map";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatPace, speedToPaceSecPerKm } from "@/lib/units";
import type { Highlight } from "@/lib/reveal";

export interface RevealRun {
  id: string;
  name: string | null;
  start_time: string;
  local_date: string;
  utc_offset_s: number | null;
  distance_m: number | null;
  moving_s: number | null;
  avg_speed_moving: number | null;
  avg_hr: number | null;
  elevation_gain_m: number | null;
  is_indoor: boolean;
  route_preview: [number, number][] | null;
  highlights: Highlight[];
  plan: { title: string; type: string; key: boolean } | null;
}

const HIGHLIGHT_ICON = { longest: Trophy, fastest: Flame, week: Timer, plan: CalendarCheck } as const;

/** 0→1 over `ms` once `start` is true (easeOutCubic). */
function useProgress(start: boolean, ms: number) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (!start) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setP(1 - (1 - t) ** 3);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, ms]);
  return p;
}

/**
 * Full-screen celebration of a newly synced run: the route draws itself on a dark map,
 * the numbers count up, then the highlights pop in. Steps through several runs if more arrived.
 */
export function NewRunReveal({ runs, onClose }: { runs: RevealRun[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const run = runs[index];
  const isLast = index === runs.length - 1;

  // lock page scroll and close on Escape while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New run"
      className="reveal-in fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-[#0a0b0d] text-white"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <RevealBody key={run.id} run={run} onNext={isLast ? onClose : () => setIndex((i) => i + 1)} onClose={onClose} isLast={isLast} position={runs.length > 1 ? `${index + 1} of ${runs.length}` : null} />
    </div>
  );
}

function RevealBody({ run, onNext, onClose, isLast, position }: { run: RevealRun; onNext: () => void; onClose: () => void; isLast: boolean; position: string | null }) {
  const coords = useMemo(() => (run.is_indoor ? [] : (run.route_preview ?? [])).filter((c) => Array.isArray(c) && c.length === 2), [run]);
  const hasRoute = coords.length >= 2;
  const drawMs = Math.min(3000, Math.max(1700, coords.length * 6));
  const [drawn, setDrawn] = useState(!hasRoute);
  const onDrawn = useCallback(() => setDrawn(true), []);
  // with a route, the numbers count up while the line draws; without one, shortly after opening
  const [statsGo, setStatsGo] = useState(false);
  const onStart = useCallback(() => setStatsGo(true), []);
  useEffect(() => {
    if (hasRoute) return;
    const t = setTimeout(() => setStatsGo(true), 350);
    return () => clearTimeout(t);
  }, [hasRoute]);
  const p = useProgress(statsGo, hasRoute ? drawMs : 1400);

  const km = (run.distance_m ?? 0) / 1000;
  const pace = speedToPaceSecPerKm(run.avg_speed_moving);
  const time = run.moving_s ?? 0;
  const when = `${formatDay(run.local_date, { weekday: "long", day: "numeric", month: "long" })} · ${localTime(run.start_time, run.utc_offset_s, Intl.DateTimeFormat().resolvedOptions().timeZone)}`;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 pt-3 pb-5">
      <div className="flex items-center justify-between">
        <span className="reveal-badge inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold">
          <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
          New run synced{position ? ` · ${position}` : ""}
        </span>
        <button onClick={onClose} aria-label="Close" className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/15">
          <X size={19} />
        </button>
      </div>

      <div className="reveal-map relative mt-4 h-[42dvh] min-h-64 overflow-hidden rounded-[1.75rem] bg-[#111316] ring-1 ring-white/8">
        {hasRoute ? <RevealMap coords={coords} durationMs={drawMs} onStart={onStart} onDrawn={onDrawn} /> : <IndoorRing progress={p} />}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#0a0b0d] to-transparent" />
        {drawn && <Burst />}
        <div className="absolute inset-x-5 bottom-4">
          <p className="reveal-up text-[0.8125rem] text-white/60" style={{ animationDelay: "250ms" }}>
            {when}
          </p>
          <p className="reveal-up truncate text-[1.625rem] leading-tight font-bold tracking-[-0.02em]" style={{ animationDelay: "350ms" }}>
            {run.name ?? "Run"}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 px-1">
        <div className="col-span-2">
          <p className="text-xs font-medium text-white/55">Distance</p>
          <p className="display mt-1 text-[4rem] leading-none">
            {(km * p).toFixed(2)}
            <span className="ml-1.5 text-lg font-medium tracking-normal text-white/55">km</span>
          </p>
        </div>
        <RevealStat label="Time" value={formatDuration(time * p)} />
        <RevealStat label="Avg pace" value={<span style={{ opacity: Math.min(1, p * 1.6) }}>{formatPace(pace)}</span>} unit="/km" />
        <RevealStat label="Avg heart rate" value={run.avg_hr ? Math.round(run.avg_hr * p) : "–"} unit={run.avg_hr ? "bpm" : undefined} />
        <RevealStat label="Elevation" value={run.elevation_gain_m != null ? Math.round(run.elevation_gain_m * p) : "–"} unit={run.elevation_gain_m != null ? "m" : undefined} />
      </div>

      {drawn && run.highlights.length > 0 && (
        <ul className="mt-5 flex flex-wrap gap-1.5">
          {run.highlights.map((h, i) => {
            const Icon = HIGHLIGHT_ICON[h.kind];
            const strong = h.kind === "longest" || h.kind === "fastest" || h.kind === "plan";
            return (
              <li
                key={h.text}
                className={clsx(
                  "reveal-pop inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-semibold",
                  strong ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "bg-white/10 text-white/85",
                )}
                style={{ animationDelay: `${150 + i * 120}ms` }}
              >
                <Icon size={15} strokeWidth={2.2} />
                {h.text}
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 mt-auto grid grid-cols-2 gap-2 bg-gradient-to-t from-[#0a0b0d] from-70% to-transparent pt-6 pb-1">
        <Link href={`/activities/${run.id}`} onClick={onClose} className="btn btn-block min-h-12 bg-white/10 text-white hover:bg-white/15">
          See details
        </Link>
        <button onClick={onNext} className="btn btn-accent btn-block min-h-12">
          {isLast ? "Nice!" : "Next run"}
        </button>
      </div>
    </div>
  );
}

function RevealStat({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-white/55">{label}</p>
      <p className="display mt-1 text-[1.75rem] leading-none whitespace-nowrap">
        {value}
        {unit && <span className="ml-1 text-[0.8125rem] font-medium tracking-normal text-white/55">{unit}</span>}
      </p>
    </div>
  );
}

/** Treadmill / no-GPS runs: a ring that fills instead of a route. */
function IndoorRing({ progress }: { progress: number }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
      <svg width={180} height={180} viewBox="0 0 180 180" aria-hidden className="-mt-10">
        <circle cx={90} cy={90} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={10} />
        <circle cx={90} cy={90} r={r} fill="none" stroke="var(--accent)" strokeWidth={10} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} transform="rotate(-90 90 90)" />
      </svg>
    </div>
  );
}

/** A small burst of accent sparks when the route finishes drawing. */
function Burst() {
  const sparks = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => {
        const a = (i / 22) * Math.PI * 2 + (i % 2) * 0.15;
        const d = 70 + ((i * 37) % 60);
        return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, s: 4 + (i % 3) * 2, delay: (i % 4) * 30, white: i % 3 === 0 };
      }),
    [],
  );
  return (
    <div aria-hidden className="pointer-events-none absolute top-[42%] left-1/2">
      {sparks.map((p, i) => (
        <span
          key={i}
          className="reveal-spark absolute rounded-full"
          style={
            {
              width: p.s,
              height: p.s,
              background: p.white ? "#fff" : "var(--accent)",
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              animationDelay: `${p.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
