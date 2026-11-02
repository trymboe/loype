"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { addDaysIso } from "@/lib/dates";

/** Time windows offered for every chart on the Progress page. `days: 0` means everything imported. */
export const RANGES = [
  { key: "1m", label: "1M", days: 30, long: "the last month" },
  { key: "3m", label: "3M", days: 91, long: "the last 3 months" },
  { key: "6m", label: "6M", days: 182, long: "the last 6 months" },
  { key: "1y", label: "1Y", days: 365, long: "the last year" },
  { key: "all", label: "All", days: 0, long: "all imported history" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];
export const DEFAULT_RANGE: RangeKey = "1m";

/** First date (YYYY-MM-DD, inclusive) inside the window ending `today`, or null for "All". */
export function rangeStart(key: RangeKey, today: string): string | null {
  const r = RANGES.find((x) => x.key === key) ?? RANGES[0];
  return r.days ? addDaysIso(today, -(r.days - 1)) : null;
}

/** Keeps the items whose date falls inside the window. `dateOf` must return a YYYY-MM-DD (or ISO) string. */
export function inRange<T>(items: T[], key: RangeKey, today: string, dateOf: (t: T) => string): T[] {
  const from = rangeStart(key, today);
  return from ? items.filter((i) => dateOf(i).slice(0, 10) >= from) : items;
}

const Ctx = createContext<{ range: RangeKey; setRange: (k: RangeKey) => void; today: string } | null>(null);

export function ChartRangeProvider({ today, children }: { today: string; children: ReactNode }) {
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  return <Ctx.Provider value={{ range, setRange, today }}>{children}</Ctx.Provider>;
}

export function useChartRange() {
  const c = useContext(Ctx);
  // Charts rendered outside the Progress page (no provider) show everything they were given.
  if (!c) return { range: "all" as RangeKey, today: "9999-12-31", filter: <T,>(items: T[]) => items, label: "all imported history" };
  const label = RANGES.find((r) => r.key === c.range)?.long ?? "";
  return {
    range: c.range,
    today: c.today,
    filter: <T,>(items: T[], dateOf: (t: T) => string) => inRange(items, c.range, c.today, dateOf),
    label,
  };
}

/** The segmented control. Sticks to the top of the page so it stays within reach while scrolling the charts. */
export function ChartRangeSelector() {
  const c = useContext(Ctx);
  if (!c) return null;
  return (
    <div className="sticky top-0 z-30 -mx-4 bg-bg/80 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-xl backdrop-saturate-150 md:-mx-2 md:px-2 md:pt-2">
      <div className="flex items-center justify-between gap-3">
        <span className="label">Chart range</span>
        <div className="seg" role="group" aria-label="Chart time range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={c.range === r.key} onClick={() => c.setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Shown in place of a chart when the chosen window has too few points to draw. */
export function EmptyRange({ what }: { what: string }) {
  const { label } = useChartRange();
  return <p className="flex h-24 items-center justify-center rounded-xl bg-surface-2 px-4 text-center text-sm text-muted">No {what} in {label}. Pick a longer range.</p>;
}
