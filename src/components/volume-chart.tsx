"use client";

import { useState } from "react";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { WeekVolume } from "@/lib/analytics/volume";
import { formatDuration } from "@/lib/units";

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
      <div className="mb-3 flex gap-1">
        {WINDOWS.map((w) => (
          <button key={w.key} onClick={() => setWin(w.key)} className={clsx("rounded-lg px-2.5 py-1 text-xs font-semibold", win === w.key ? "bg-fg text-bg" : "bg-surface-2 text-muted")}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 0, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
            <XAxis dataKey="weekStart" tickFormatter={(v: string) => v.slice(5).replace("-", "/")} tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (WeekVolume & { km: number; longKm: number }) | undefined;
                if (!active || !p) return null;
                return (
                  <div className="card tabular px-3 py-2 text-xs">
                    <p className="font-semibold">Week of {p.weekStart}</p>
                    <p>{p.km} km · {p.runs} runs · {formatDuration(p.movingS)}</p>
                    <p className="text-muted">Longest run {p.longKm} km</p>
                  </div>
                );
              }}
            />
            <Bar dataKey="km" fill="var(--accent)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
