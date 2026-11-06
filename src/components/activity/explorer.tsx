"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { BarChart3, MousePointer2, X } from "lucide-react";
import clsx from "clsx";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "@/lib/analytics/series";
import { nearestIndex, summarizeSegment } from "@/lib/analytics/segment";
import { formatDuration, formatPace, formatPaceFromSpeed } from "@/lib/units";
import { LapCompare } from "./lap-compare";
import { RouteMap } from "./route-map";
import { SurfaceBreakdown, useSurfaces } from "@/components/routes/surface-breakdown";

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
  // chart range selection: drag across a chart in "select" mode
  const [selecting, setSelecting] = useState(false);
  const [range, setRange] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const [comparing, setComparing] = useState(false);
  const [cmp, setCmp] = useState<number[]>([]);

  const coords = useMemo(
    () => points.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lng!, p.lat!] as [number, number]),
    [points],
  );
  const surfaceKey = coords.length > 1 ? `${coords.length}:${coords[0]}` : null;
  const surface = useSurfaces(coords, surfaceKey, { gps: true, delayMs: 0 });
  const [surfaceOnMap, setSurfaceOnMap] = useState(false);
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

  const selection = useMemo(() => (range ? summarizeSegment(points, range[0], range[1]) : null), [range, points]);
  const selRange = useMemo(() => {
    if (!selection) return null;
    const seg = points.slice(selection.startIdx, selection.endIdx + 1);
    return { x1: seg[0][xKey], x2: seg[seg.length - 1][xKey], coords: seg.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lng!, p.lat!] as [number, number]) };
  }, [selection, points, xKey]);
  const shaded = selRange ?? lapRange;

  /** Pointer x → nearest series index. Every chart shares the same plot area: 40 px y-axis on the left, 4 px margin on the right. */
  const indexAt = (clientX: number) => {
    const el = chartsRef.current;
    if (!el || !points.length) return null;
    const r = el.getBoundingClientRect();
    const left = r.left + 40;
    const w = Math.max(1, r.width - 44);
    const f = Math.max(0, Math.min(1, (clientX - left) / w));
    const min = points[0][xKey];
    const max = points[points.length - 1][xKey];
    return nearestIndex(points, xKey, min + f * (max - min));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!selecting) return;
    const i = indexAt(e.clientX);
    if (i == null) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    anchor.current = i;
    setLap(null);
    setRange([i, i]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!selecting || anchor.current == null) return;
    const i = indexAt(e.clientX);
    if (i != null) setRange([anchor.current, i]);
  };
  const onPointerUp = () => {
    if (!selecting || anchor.current == null) return;
    anchor.current = null;
    setRange((r) => (r && Math.abs(r[1] - r[0]) >= 2 ? r : null));
    setSelecting(false); // give scrolling back on touch screens
  };

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
  const ref = shaded ? <ReferenceArea x1={shaded.x1} x2={shaded.x2} fill={selRange ? "var(--accent)" : "var(--fg)"} fillOpacity={selRange ? 0.12 : 0.07} /> : null;
  const tip = <Tooltip content={() => null} cursor={{ stroke: "var(--fg-2)", strokeWidth: 1, strokeOpacity: 0.5 }} />;

  return (
    <div className="space-y-3">
      {coords.length > 1 && <RouteMap coords={coords} hover={hover?.lat != null ? [hover.lng!, hover.lat!] : null} highlight={shaded?.coords ?? null} surface={surfaceOnMap ? surface.data?.segments : null} />}

      <div className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="tabular flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] font-medium">
            {hover && (
              <>
                <span className="text-muted">{xMode === "distance" ? `${hover.d.toFixed(2)} km` : formatDuration(hover.t)}</span>
                {hasPace && <span style={{ color: "var(--pace)" }}>{formatPace(hover.pace)} /km</span>}
                {hasHr && <span style={{ color: "var(--hr)" }}>{hover.hr ?? "–"} bpm</span>}
                {hasCad && <span style={{ color: "var(--cadence)" }}>{hover.cad ?? "–"} spm</span>}
                {hasAlt && <span className="text-muted">{hover.alt != null ? `${Math.round(hover.alt)} m` : "–"}</span>}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => setSelecting((v) => !v)}
              title="Select a stretch"
              className={clsx("chip !min-h-[2.25rem] !px-2.5", selecting && "!bg-accent !text-accent-fg")}
            >
              <MousePointer2 size={15} />
              <span className="hidden sm:inline">Select</span>
            </button>
            <div className="seg">
              {(["distance", "time"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={xMode === m} onClick={() => setXMode(m)} className="capitalize">
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        {selection && (
          <div className="-mt-1 mb-4 rounded-xl bg-accent/8 p-3" data-testid="selection-summary">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-accent">
                Selected{" "}
                {xMode === "distance"
                  ? `${points[selection.startIdx].d.toFixed(2)}–${points[selection.endIdx].d.toFixed(2)} km`
                  : `${formatDuration(points[selection.startIdx].t)}–${formatDuration(points[selection.endIdx].t)}`}
              </p>
              <button type="button" onClick={() => setRange(null)} className="-m-1 rounded-lg p-1 text-muted hover:text-fg" aria-label="Clear selection">
                <X size={16} />
              </button>
            </div>
            <div className="tabular mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-sm sm:grid-cols-6">
              <Mini label="Distance" value={`${(selection.distanceM / 1000).toFixed(2)} km`} />
              <Mini label="Time" value={formatDuration(selection.movingS)} hint={selection.elapsedS - selection.movingS > 5 ? `${formatDuration(selection.elapsedS)} elapsed` : undefined} />
              <Mini label="Pace" value={selection.paceSPerKm ? `${formatPace(selection.paceSPerKm)} /km` : "–"} color="var(--pace)" />
              <Mini label="Avg HR" value={selection.avgHr ? `${Math.round(selection.avgHr)} bpm` : "–"} color="var(--hr)" hint={selection.hrDriftBpm != null && Math.abs(selection.hrDriftBpm) >= 3 ? `${selection.hrDriftBpm > 0 ? "+" : "−"}${Math.abs(Math.round(selection.hrDriftBpm))} bpm drift` : undefined} />
              <Mini label="Cadence" value={selection.avgCadence ? `${Math.round(selection.avgCadence)} spm` : "–"} />
              <Mini label="Elevation" value={selection.elevGainM != null ? `+${Math.round(selection.elevGainM)} / −${Math.round(selection.elevLossM ?? 0)} m` : "–"} />
            </div>
          </div>
        )}

        <div
          ref={chartsRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={selecting ? { touchAction: "none", cursor: "col-resize" } : undefined}
          className={clsx(selecting && "select-none")}
          data-testid="charts"
        >

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
      </div>

      {laps.length > 1 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 pt-5">
            <h2 className="section-title">Laps</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={comparing}
                onClick={() => {
                  setComparing((c) => !c);
                  setCmp([]);
                }}
                className="chip !min-h-8"
              >
                <BarChart3 size={14} /> {comparing ? "Done" : "Compare"}
              </button>
            </div>
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
              {laps.map((l) => {
                const picked = comparing ? cmp.includes(l.index) : lap === l.index;
                const toggle = () => {
                  if (comparing) setCmp((c) => (c.includes(l.index) ? c.filter((x) => x !== l.index) : c.length >= 8 ? c : [...c, l.index]));
                  else {
                    setRange(null);
                    setLap(lap === l.index ? null : l.index);
                  }
                };
                return (
                <tr
                  key={l.index}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  tabIndex={0}
                  aria-selected={picked}
                  className={clsx("cursor-pointer border-t border-[var(--hairline)] transition-colors", picked ? "bg-accent/10" : "hover:bg-surface-2/60")}
                >
                  <td className={clsx("py-2.5 pl-5", picked ? "font-semibold text-accent" : "text-muted")}>
                    {comparing && (
                      <span
                        aria-hidden
                        className={clsx("mr-2 inline-flex size-4 items-center justify-center rounded border align-[-2px] text-[10px]", picked ? "border-accent bg-accent text-accent-fg" : "border-[var(--border)]")}
                      >
                        {picked ? cmp.indexOf(l.index) + 1 : ""}
                      </span>
                    )}
                    {l.index + 1}
                    {l.intensity && l.intensity !== "active" && <span className="ml-1 text-[10px] uppercase">{l.intensity}</span>}
                  </td>
                  <td>{l.distanceM != null ? (l.distanceM / 1000).toFixed(2) : "–"}</td>
                  <td>{formatDuration(l.timerS)}</td>
                  <td className="font-semibold">{formatPaceFromSpeed(l.avgSpeed)}</td>
                  <td className="pr-5 text-right sm:pr-0">{l.avgHr != null ? Math.round(l.avgHr) : "–"}</td>
                  <td className="hidden pr-5 text-right sm:table-cell">{l.avgCadence != null ? Math.round(l.avgCadence) : "–"}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {comparing && <LapCompare laps={laps} points={points} selected={cmp} onSelect={setCmp} />}
        </div>
      )}

      <SurfaceBreakdown data={surface.data} state={surface.state} onMap={surfaceOnMap} onToggleMap={setSurfaceOnMap} />
    </div>
  );
}

function Mini({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className="truncate font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint && <div className="truncate text-[0.6875rem] text-muted">{hint}</div>}
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
