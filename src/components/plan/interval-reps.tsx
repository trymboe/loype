import clsx from "clsx";
import type { IntervalAnalysis } from "@/lib/planning/intervals";
import { formatPace } from "@/lib/units";

/** Per-rep pace bars against the target band, with HR and recovery, and what the pattern means. */
export function IntervalReps({ a }: { a: IntervalAnalysis }) {
  const paces = a.reps.map((r) => r.paceSPerKm);
  const lo = Math.min(...paces, a.target?.[0] ?? Infinity) * 0.97;
  const hi = Math.max(...paces, a.target?.[1] ?? 0) * 1.03;
  // faster pace = longer bar
  const w = (p: number) => `${Math.max(6, ((hi - p) / (hi - lo)) * 100)}%`;
  return (
    <div className="mt-5 border-t border-[var(--hairline)] pt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Rep by rep</h3>
        <span className="text-xs text-muted">{a.source === "laps" ? "from your watch laps" : "detected from pace"}</span>
      </div>
      <div className="relative space-y-1.5">
        {a.target && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 rounded bg-accent/10"
            style={{ left: `calc(2.5rem + (100% - 11rem) * ${(hi - a.target[1]) / (hi - lo)})`, width: `calc((100% - 11rem) * ${(a.target[1] - a.target[0]) / (hi - lo)})` }}
          />
        )}
        {a.reps.map((r) => (
          <div key={r.index} className="relative flex items-center gap-2 text-xs">
            <span className="tabular w-8 shrink-0 text-muted">#{r.index}</span>
            <div className="h-4 min-w-0 flex-1">
              <div className={clsx("h-full rounded-sm", r.onTarget === false ? "bg-warn" : "bg-intervals")} style={{ width: w(r.paceSPerKm) }} />
            </div>
            <span className="tabular w-12 shrink-0 text-right font-semibold">{formatPace(r.paceSPerKm)}</span>
            <span className="tabular w-[4.5rem] shrink-0 text-right text-muted">
              {r.avgHr ?? "–"}
              {r.hrr60 != null && <span className="text-subtle"> ↓{r.hrr60}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-end gap-3 text-[0.6875rem] text-subtle">
        <span>pace /km</span>
        <span>avg HR ↓ drop in 60 s after</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-muted">Variation</div>
          <div className="tabular font-semibold">{a.paceCvPct} %</div>
        </div>
        <div>
          <div className="text-muted">Fade</div>
          <div className="tabular font-semibold">{a.fadePct > 0 ? "+" : ""}{a.fadePct} %</div>
        </div>
        <div>
          <div className="text-muted">HR drift</div>
          <div className="tabular font-semibold">{a.hrDrift != null ? `${a.hrDrift > 0 ? "+" : ""}${a.hrDrift} bpm` : "–"}</div>
        </div>
      </div>
      {a.notes.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-surface-2 p-3 text-sm leading-snug text-fg-2">
          {a.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
