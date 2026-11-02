"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RouteMap } from "@/components/activity/route-map";
import type { CoursePoint } from "@/lib/race/gpx";

const axis = { tick: { fontSize: 11, fill: "var(--subtle)" }, tickLine: false, axisLine: false } as const;

/** Course map with an elevation profile; hovering the profile marks the spot on the map. */
export function CourseView({ points }: { points: CoursePoint[] }) {
  const coords = useMemo(() => points.map((p) => [p[0], p[1]] as [number, number]), [points]);
  const data = useMemo(() => points.map((p, i) => ({ i, km: p[3] / 1000, ele: p[2] })), [points]);
  const hasEle = points.some((p) => p[2] != null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const eles = points.map((p) => p[2]).filter((e): e is number => e != null);
  const lo = eles.length ? Math.floor(Math.min(...eles) / 10) * 10 - 10 : 0;
  const hi = eles.length ? Math.ceil(Math.max(...eles) / 10) * 10 + 10 : 1;
  return (
    <div className="space-y-3">
      <RouteMap coords={coords} hover={hover} highlight={null} />
      {hasEle && (
        <div className="h-36" onMouseLeave={() => setHover(null)}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 4, right: 4, left: -18, bottom: 0 }}
              onMouseMove={(s) => {
                const idx = typeof s?.activeTooltipIndex === "number" ? s.activeTooltipIndex : Number(s?.activeTooltipIndex);
                setHover(Number.isFinite(idx) && coords[idx] ? coords[idx] : null);
              }}
            >
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="km" type="number" domain={[0, "dataMax"]} tickFormatter={(v: number) => `${Math.round(v)}`} unit=" km" minTickGap={28} {...axis} />
              <YAxis domain={[lo, hi]} unit=" m" width={56} {...axis} />
              <Tooltip
                cursor={{ stroke: "var(--subtle)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as { km: number; ele: number | null } | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="chart-tip">
                      <p className="font-semibold">{p.km.toFixed(2)} km</p>
                      {p.ele != null && <p className="text-muted">{Math.round(p.ele)} m</p>}
                    </div>
                  );
                }}
              />
              <Area dataKey="ele" stroke="var(--elev)" strokeWidth={1.75} fill="var(--elev)" fillOpacity={0.18} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
