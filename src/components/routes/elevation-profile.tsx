"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type P = { d: number; ele: number | null; lng: number; lat: number };

/** Elevation along a route (km on x); hovering moves a dot on the map via onHover. */
export function ElevationProfile({ data, onHover }: { data: P[]; onHover?: (p: [number, number] | null) => void }) {
  if (!data.some((p) => p.ele != null)) return null;
  return (
    <section className="card p-4">
      <div className="flex items-baseline gap-1 text-[0.6875rem] text-muted">
        <span className="font-semibold text-fg-2">Elevation</span>
        <span>m</span>
      </div>
      <div className="mt-1 h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
            onMouseMove={(s) => {
              const i = s?.activeTooltipIndex;
              const p = i == null ? null : data[Number(i)];
              onHover?.(p ? [p.lng, p.lat] : null);
            }}
            onMouseLeave={() => onHover?.(null)}
          >
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="d"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v: number) => `${v.toFixed(v < 10 ? 1 : 0)}`}
              tick={{ fontSize: 10, fill: "var(--subtle)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis domain={["dataMin - 5", "dataMax + 5"]} width={40} tick={{ fontSize: 10, fill: "var(--subtle)" }} tickLine={false} axisLine={false} tickFormatter={(v) => String(Math.round(v))} />
            <Tooltip
              cursor={{ stroke: "var(--fg-2)", strokeWidth: 1, strokeOpacity: 0.5 }}
              content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as P | undefined) : undefined;
                if (!p) return null;
                return (
                  <div className="chart-tip tabular">
                    {p.d.toFixed(2)} km · {p.ele != null ? `${Math.round(p.ele)} m` : "–"}
                  </div>
                );
              }}
            />
            <Area dataKey="ele" stroke="var(--elev)" fill="var(--elev)" fillOpacity={0.18} strokeWidth={1.25} isAnimationActive={false} connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
