"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { WeekVolume } from "@/lib/analytics/volume";
import { formatDuration } from "@/lib/units";

const shortDate = (v: string) => new Date(`${v}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const WINDOWS = [
  { key: 4, label: "4W" },
  { key: 13, label: "3M" },
  { key: 26, label: "6M" },
  { key: 52, label: "12M" },
  { key: 0, label: "All" },
];

export function VolumeChart({ weeks }: { weeks: WeekVolume[] }) {
  const [win, setWin] = useState(13);
  const data = (win ? weeks.slice(-win) : weeks).map((w) => ({ ...w, km: Math.round(w.distanceM / 100) / 10, longKm: Math.round(w.longestM / 100) / 10 }));
  return (
    <div>
      <div className="seg mb-4 w-full">
        {WINDOWS.map((w) => (
          <button key={w.key} type="button" aria-pressed={win === w.key} onClick={() => setWin(w.key)} className="flex-1">
            {w.label}
          </button>
        ))}
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 0, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="weekStart" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "var(--subtle)" }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "var(--grid)" }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (WeekVolume & { km: number; longKm: number }) | undefined;
                if (!active || !p) return null;
                return (
                  <div className="chart-tip">
                    <p className="mb-0.5 font-semibold">Week of {p.weekStart}</p>
                    <p>{p.km} km · {p.runs} runs · {formatDuration(p.movingS)}</p>
                    <p className="text-muted">Longest run {p.longKm} km</p>
                  </div>
                );
              }}
            />
            <Bar dataKey="km" radius={[4, 4, 1, 1]} maxBarSize={28} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={d.weekStart} fill="var(--accent)" fillOpacity={i === data.length - 1 ? 0.35 : 0.9} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
