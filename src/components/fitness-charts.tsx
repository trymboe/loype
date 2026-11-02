"use client";

import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis, Bar } from "recharts";

const axis = { tick: { fontSize: 11, fill: "var(--subtle)" }, tickLine: false, axisLine: false } as const;
const grid = { vertical: false, stroke: "var(--grid)" } as const;

export function Legend({ items }: { items: { label: string; color: string; kind?: "line" | "bar" | "dot" }[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span
            className={i.kind === "bar" ? "h-2.5 w-2 rounded-[2px]" : i.kind === "dot" ? "size-2 rounded-full" : "h-[2px] w-3 rounded-full"}
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}
const md = (v: string) => new Date(`${v.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export interface TrendPoint {
  date: string;
  value: number | null;
  band: [number, number] | null;
  confidence: string | null;
}

export function FitnessTrendChart({ points }: { points: TrendPoint[] }) {
  const values = points.flatMap((p) => (p.band ? p.band : p.value != null ? [p.value] : []));
  if (values.length < 2) return <p className="text-sm text-muted">Not enough weekly estimates yet to draw a trend.</p>;
  const lo = Math.floor(Math.min(...values) - 1);
  const hi = Math.ceil(Math.max(...values) + 1);
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="date" tickFormatter={md} minTickGap={24} {...axis} />
          <YAxis domain={[lo, hi]} {...axis} />
          <Tooltip
            cursor={{ stroke: "var(--subtle)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as TrendPoint | undefined;
              if (!active || !p) return null;
              return (
                <div className="chart-tip">
                  <p className="mb-0.5 font-semibold">Week ending {p.date}</p>
                  {p.value != null ? (
                    <p>
                      {p.value.toFixed(1)} {p.band && <span className="text-muted">({p.band[0].toFixed(1)}–{p.band[1].toFixed(1)})</span>}
                    </p>
                  ) : (
                    <p className="text-muted">Withheld: not enough evidence</p>
                  )}
                  {p.confidence && <p className="text-muted">{p.confidence} confidence</p>}
                </div>
              );
            }}
          />
          <Area dataKey="band" stroke="none" fill="var(--accent)" fillOpacity={0.14} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="value" stroke="var(--accent)" strokeWidth={2.25} dot={{ r: 2.5, fill: "var(--accent)", strokeWidth: 0 }} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface LoadPoint {
  date: string;
  run: number;
  other: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export function LoadChart({ days }: { days: LoadPoint[] }) {
  return (
    <div>
      <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={days} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="date" tickFormatter={md} minTickGap={24} {...axis} />
          <YAxis {...axis} />
          <Tooltip
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as LoadPoint | undefined;
              if (!active || !p) return null;
              return (
                <div className="chart-tip">
                  <p className="mb-0.5 font-semibold">{p.date}</p>
                  <p>
                    Load {Math.round(p.run + p.other)}
                    {p.other > 0 && <span className="text-muted"> ({Math.round(p.other)} other sports)</span>}
                  </p>
                  <p style={{ color: "var(--accent)" }}>Fitness {p.ctl.toFixed(0)}</p>
                  <p style={{ color: "var(--cadence)" }}>Fatigue {p.atl.toFixed(0)}</p>
                  <p className="text-muted">Form {p.tsb > 0 ? "+" : ""}{p.tsb.toFixed(0)}</p>
                </div>
              );
            }}
          />
          <Bar dataKey="run" stackId="l" fill="var(--chart-bar)" isAnimationActive={false} />
          <Bar dataKey="other" stackId="l" fill="var(--tempo)" fillOpacity={0.45} isAnimationActive={false} />
          <Line dataKey="ctl" stroke="var(--accent)" strokeWidth={2.25} dot={false} isAnimationActive={false} />
          <Line dataKey="atl" stroke="var(--cadence)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      </div>
      <Legend
        items={[
          { label: "Fitness", color: "var(--accent)" },
          { label: "Fatigue", color: "var(--cadence)" },
          { label: "Daily load", color: "var(--chart-bar)", kind: "bar" },
          { label: "Other sports", color: "color-mix(in srgb, var(--tempo) 45%, transparent)", kind: "bar" },
        ]}
      />
    </div>
  );
}

export interface EfPoint {
  date: string;
  ef: number;
  t: number;
  trend?: number;
}

export function EfficiencyChart({ points }: { points: EfPoint[] }) {
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => md(new Date(v).toISOString().slice(0, 10))} minTickGap={24} {...axis} />
          <YAxis domain={["dataMin - 0.05", "dataMax + 0.05"]} tickFormatter={(v: number) => v.toFixed(2)} {...axis} />
          <Tooltip
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as EfPoint | undefined;
              if (!active || !p) return null;
              return (
                <div className="chart-tip">
                  <p className="mb-0.5 font-semibold">{p.date}</p>
                  <p>{p.ef.toFixed(3)} m/min per bpm</p>
                </div>
              );
            }}
          />
          <Scatter dataKey="ef" fill="var(--easy)" fillOpacity={0.75} isAnimationActive={false} />
          <Line dataKey="trend" stroke="var(--fg-2)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
