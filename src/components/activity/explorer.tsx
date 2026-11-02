"use client";

import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "@/lib/analytics/series";
import { formatDuration, formatPace, formatPaceFromSpeed } from "@/lib/units";
import { RouteMap } from "./route-map";

export interface LapView {
  index: number;
  startT: number;
  endT: number;
  distanceM: number | null;
  timerS: number | null;
  avgSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  intensity: string | null;
}

type XMode = "distance" | "time";

const pct = (vals: number[], p: number) => {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

export function ActivityExplorer({ points, laps }: { points: ChartPoint[]; laps: LapView[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [lap, setLap] = useState<number | null>(null);
  const [xMode, setXMode] = useState<XMode>("distance");
  const xKey = xMode === "distance" ? "d" : "t";

  const coords = useMemo(
    () => points.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lng!, p.lat!] as [number, number]),
    [points],
  );
  const hasPace = points.some((p) => p.pace != null);
  const hasHr = points.some((p) => p.hr != null);
  const hasCad = points.some((p) => p.cad != null);
  const hasAlt = points.some((p) => p.alt != null);

  const paceDomain = useMemo(() => {
    const v = points.map((p) => p.pace).filter((x): x is number => x != null);
    // reversed axis: fast at the top. Clip extremes so a single sprint/stop doesn't flatten the chart.
    return [Math.floor((pct(v, 0.02) - 15) / 15) * 15, Math.ceil((pct(v, 0.98) + 15) / 15) * 15] as [number, number];
  }, [points]);

  const selected = lap != null ? laps.find((l) => l.index === lap) ?? null : null;
  const lapRange = useMemo(() => {
    if (!selected) return null;
    const inLap = points.filter((p) => p.t >= selected.startT && p.t <= selected.endT);
    if (inLap.length < 2) return null;
    return { x1: inLap[0][xKey], x2: inLap[inLap.length - 1][xKey], coords: inLap.filter((p) => p.lat != null).map((p) => [p.lng!, p.lat!] as [number, number]) };
  }, [selected, points, xKey]);

  const hover = hoverIdx != null ? points[hoverIdx] : null;
  const onMove = useCallback((state: { activeTooltipIndex?: number | string | null }) => {
    const i = state?.activeTooltipIndex;
    setHoverIdx(i == null ? null : Number(i));
  }, []);

  const xTick = (v: number) => (xMode === "distance" ? `${v.toFixed(v < 10 ? 1 : 0)}` : formatDuration(v));
  const common = {
    data: points,
    syncId: "activity",
    syncMethod: "index" as const,
    margin: { top: 6, right: 4, bottom: 0, left: 0 },
    onMouseMove: onMove,
    onMouseLeave: () => setHoverIdx(null),
  };
  const xAxis = (
    <XAxis
      dataKey={xKey}
      type="number"
      domain={["dataMin", "dataMax"]}
      tickFormatter={xTick}
      tick={{ fontSize: 10, fill: "var(--subtle)" }}
      tickLine={false}
      axisLine={false}
      minTickGap={32}
    />
  );
  const grid = <CartesianGrid vertical={false} stroke="var(--grid)" />;
  const ref = lapRange ? <ReferenceArea x1={lapRange.x1} x2={lapRange.x2} fill="var(--fg)" fillOpacity={0.07} /> : null;
  const tip = <Tooltip content={() => null} cursor={{ stroke: "var(--fg-2)", strokeWidth: 1, strokeOpacity: 0.5 }} />;

  return (
    <div className="space-y-3">
      {coords.length > 1 && <RouteMap coords={coords} hover={hover?.lat != null ? [hover.lng!, hover.lat!] : null} highlight={lapRange?.coords ?? null} />}

      <div className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="tabular flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] font-medium">
            {hover ? (
              <>
                <span className="text-muted">{xMode === "distance" ? `${hover.d.toFixed(2)} km` : formatDuration(hover.t)}</span>
                {hasPace && <span style={{ color: "var(--pace)" }}>{formatPace(hover.pace)} /km</span>}
                {hasHr && <span style={{ color: "var(--hr)" }}>{hover.hr ?? "–"} bpm</span>}
                {hasCad && <span style={{ color: "var(--cadence)" }}>{hover.cad ?? "–"} spm</span>}
                {hasAlt && <span className="text-muted">{hover.alt != null ? `${Math.round(hover.alt)} m` : "–"}</span>}
              </>
            ) : (
              <span className="font-normal text-muted">Touch the charts to inspect</span>
            )}
          </div>
          <div className="seg shrink-0">
            {(["distance", "time"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={xMode === m} onClick={() => setXMode(m)} className="capitalize">
                {m}
              </button>
            ))}
          </div>
        </div>

        {hasPace && (
          <ChartBlock label="Pace" unit="/km">
            <LineChart {...common}>
              {grid}
              {xAxis}
              <YAxis reversed domain={paceDomain} allowDataOverflow tickFormatter={(v) => formatPace(v)} width={40} tick={{ fontSize: 10, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
              {ref}
              {tip}
              <Line dataKey="pace" stroke="var(--pace)" strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls={false} />
            </LineChart>
          </ChartBlock>
        )}
        {hasHr && (
          <ChartBlock label="Heart rate" unit="bpm">
            <LineChart {...common}>
              {grid}
              {xAxis}
              <YAxis domain={["dataMin - 5", "dataMax + 5"]} width={40} tick={{ fontSize: 10, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
              {ref}
              {tip}
              <Line dataKey="hr" stroke="var(--hr)" strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartBlock>
        )}
        {hasCad && (
          <ChartBlock label="Cadence" unit="spm">
            <LineChart {...common}>
              {grid}
              {xAxis}
              <YAxis domain={[(d: number) => Math.max(0, Math.floor(d / 10) * 10 - 10), "dataMax + 5"]} width={40} tick={{ fontSize: 10, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
              {ref}
              {tip}
              <Line dataKey="cad" stroke="var(--cadence)" strokeWidth={1.2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartBlock>
        )}
        {hasAlt && (
          <ChartBlock label="Elevation" unit="m">
            <AreaChart {...common}>
              {grid}
              {xAxis}
              <YAxis domain={["dataMin - 5", "dataMax + 5"]} width={40} tick={{ fontSize: 10, fill: "var(--subtle)" }} tickLine={false} axisLine={false} tickFormatter={(v) => String(Math.round(v))} />
              {ref}
              {tip}
              <Area dataKey="alt" stroke="var(--elev)" fill="var(--elev)" fillOpacity={0.18} strokeWidth={1.25} isAnimationActive={false} />
            </AreaChart>
          </ChartBlock>
        )}
      </div>

      {laps.length > 1 && (
        <div className="card overflow-hidden">
          <div className="flex items-baseline justify-between px-5 pt-5">
            <h2 className="section-title">Laps</h2>
            <span className="text-xs text-muted">Tap a lap to highlight it</span>
          </div>
          <table className="tabular mt-3 w-full text-sm">
            <thead className="text-left text-[0.6875rem] text-muted">
              <tr>
                <th className="py-2 pl-5 font-medium">Lap</th>
                <th className="py-2 font-medium">Dist</th>
                <th className="py-2 font-medium">Time</th>
                <th className="py-2 font-medium">Pace</th>
                <th className="py-2 pr-5 text-right font-medium sm:pr-0">HR</th>
                <th className="hidden py-2 pr-5 text-right font-medium sm:table-cell">Cad</th>
              </tr>
            </thead>
            <tbody>
              {laps.map((l) => (
                <tr
                  key={l.index}
                  onClick={() => setLap(lap === l.index ? null : l.index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setLap(lap === l.index ? null : l.index);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={lap === l.index}
                  className={clsx("cursor-pointer border-t border-[var(--hairline)] transition-colors", lap === l.index ? "bg-accent/10" : "hover:bg-surface-2/60")}
                >
                  <td className={clsx("py-2.5 pl-5", lap === l.index ? "font-semibold text-accent" : "text-muted")}>
                    {l.index + 1}
                    {l.intensity && l.intensity !== "active" && <span className="ml-1 text-[10px] uppercase">{l.intensity}</span>}
                  </td>
                  <td>{l.distanceM != null ? (l.distanceM / 1000).toFixed(2) : "–"}</td>
                  <td>{formatDuration(l.timerS)}</td>
                  <td className="font-semibold">{formatPaceFromSpeed(l.avgSpeed)}</td>
                  <td className="pr-5 text-right sm:pr-0">{l.avgHr != null ? Math.round(l.avgHr) : "–"}</td>
                  <td className="hidden pr-5 text-right sm:table-cell">{l.avgCadence != null ? Math.round(l.avgCadence) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChartBlock({ label, unit, children }: { label: string; unit: string; children: React.ReactElement }) {
  return (
    <div className="mt-4 first:mt-0">
      <div className="flex items-baseline gap-1 text-[0.6875rem] text-muted">
        <span className="font-semibold text-fg-2">{label}</span>
        <span>{unit}</span>
      </div>
      <div className="h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
