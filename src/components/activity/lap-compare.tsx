"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "@/lib/analytics/series";
import { compareLaps, lapSeries, workLaps, type LapLike } from "@/lib/analytics/segment";
import { formatDuration, formatPace } from "@/lib/units";

const COLORS = ["var(--accent)", "var(--pace)", "var(--cadence)", "var(--tempo)", "var(--good)", "var(--hr)", "var(--fg-2)", "var(--elev)"];

const signed = (v: number, digits = 0) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;

/**
 * Side-by-side comparison of chosen laps: deltas against the first pick,
 * rep-to-rep consistency, and pace/HR overlaid by distance into each lap.
 */
export function LapCompare({ laps, points, selected, onSelect }: { laps: LapLike[]; points: ChartPoint[]; selected: number[]; onSelect: (s: number[]) => void }) {
  const [metric, setMetric] = useState<"pace" | "hr">("pace");
  const work = useMemo(() => workLaps(laps), [laps]);
  const chosen = useMemo(() => selected.map((i) => laps.find((l) => l.index === i)).filter((l): l is LapLike => !!l), [selected, laps]);
  const cmp = useMemo(() => compareLaps(chosen), [chosen]);
  const series = useMemo(() => chosen.map((l) => lapSeries(points, l, "d")), [chosen, points]);
  const hasHr = series.some((s) => s.some((p) => p.hr != null));
  const maxX = Math.max(0, ...series.map((s) => s[s.length - 1]?.x ?? 0));

  return (
    <div className="border-t border-[var(--hairline)] bg-surface-2/30 px-5 py-4" data-testid="lap-compare">
      <div className="flex flex-wrap items-center gap-2">
        {work.length >= 2 && (
          <button type="button" className="chip" onClick={() => onSelect(work.slice(0, 8))}>
            Work laps ({work.length})
          </button>
        )}
        <button type="button" className="chip" onClick={() => onSelect(laps.slice(0, 8).map((l) => l.index))}>
          {laps.length > 8 ? "First 8" : "All laps"}
        </button>
        {selected.length > 0 && (
          <button type="button" className="chip bg-transparent text-muted" onClick={() => onSelect([])}>
            Clear
          </button>
        )}
      </div>

      {!cmp ? (
        <p className="mt-3 text-sm text-muted">Pick two or more laps in the table. The first one you pick is the reference.</p>
      ) : (
        <>
          <table className="tabular mt-4 w-full text-sm">
            <thead className="text-left text-[0.6875rem] text-muted">
              <tr>
                <th className="py-1.5 font-medium">Lap</th>
                <th className="py-1.5 font-medium">Pace</th>
                <th className="py-1.5 font-medium">Δ</th>
                <th className="py-1.5 text-right font-medium">HR</th>
                <th className="py-1.5 text-right font-medium">Δ</th>
                <th className="hidden py-1.5 text-right font-medium sm:table-cell">Time</th>
              </tr>
            </thead>
            <tbody>
              {cmp.rows.map((r, k) => (
                <tr key={r.index} className="border-t border-[var(--hairline)]">
                  <td className="py-2">
                    <span className="mr-2 inline-block size-2.5 rounded-full" style={{ background: COLORS[k % COLORS.length] }} />
                    {r.index + 1}
                  </td>
                  <td className="font-semibold">{formatPace(r.paceSPerKm)}</td>
                  <td className={clsx(k === 0 ? "text-subtle" : r.paceDelta != null && r.paceDelta < 0 ? "text-good" : "text-muted")}>
                    {k === 0 ? "ref" : r.paceDelta != null ? `${signed(r.paceDelta)} s` : "–"}
                  </td>
                  <td className="text-right">{r.avgHr != null ? Math.round(r.avgHr) : "–"}</td>
                  <td className="text-right text-muted">{k === 0 ? "" : r.hrDelta != null ? signed(r.hrDelta) : "–"}</td>
                  <td className="hidden text-right text-muted sm:table-cell">{formatDuration(r.timerS)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {cmp.consistency && (
            <div className="mt-3 grid grid-cols-3 gap-3 rounded-xl bg-surface p-3 text-sm">
              <Fact label="Pace spread" value={`±${cmp.consistency.paceCvPct.toFixed(1)} %`} hint={cmp.consistency.paceCvPct <= 2 ? "very even" : cmp.consistency.paceCvPct <= 4 ? "fairly even" : "uneven"} />
              <Fact label="Last vs first third" value={`${signed(cmp.consistency.fadeSPerKm)} s/km`} hint={cmp.consistency.fadeSPerKm > 5 ? "slowed down" : cmp.consistency.fadeSPerKm < -5 ? "got faster" : "held pace"} />
              <Fact label="HR rise" value={cmp.consistency.hrRiseBpm != null ? `${signed(cmp.consistency.hrRiseBpm)} bpm` : "–"} hint="last vs first third" />
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[0.6875rem] text-muted">
              {metric === "pace" ? "Pace /km" : "Heart rate bpm"} by metres into the lap
            </span>
            {hasHr && (
              <div className="seg">
                {(["pace", "hr"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>
                    {m === "pace" ? "Pace" : "HR"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-1 h-36 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={[0, Math.ceil(maxX / 100) * 100 || 100]}
                  tickFormatter={(v: number) => `${Math.round(v)}`}
                  tick={{ fontSize: 10, fill: "var(--subtle)" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                  allowDuplicatedCategory={false}
                />
                <YAxis
                  reversed={metric === "pace"}
                  domain={metric === "pace" ? ["dataMin - 10", "dataMax + 10"] : ["dataMin - 5", "dataMax + 5"]}
                  tickFormatter={(v: number) => (metric === "pace" ? formatPace(v) : String(Math.round(v)))}
                  width={40}
                  tick={{ fontSize: 10, fill: "var(--subtle)" }}
                  tickLine={false}
                  axisLine={false}
                  allowDataOverflow
                />
                <Tooltip content={() => null} cursor={{ stroke: "var(--fg-2)", strokeWidth: 1, strokeOpacity: 0.4 }} />
                {series.map((s, k) => (
                  <Line
                    key={chosen[k].index}
                    data={s}
                    dataKey={metric}
                    stroke={COLORS[k % COLORS.length]}
                    strokeWidth={k === 0 ? 2.25 : 1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className="tabular font-semibold">{value}</div>
      <div className="text-[0.6875rem] text-muted">{hint}</div>
    </div>
  );
}
