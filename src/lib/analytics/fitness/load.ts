/**
 * Training load trends. Daily TRIMP (runs + other HR-recorded activities) is
 * smoothed with exponentially weighted averages (Banister impulse–response):
 *   fitness (CTL) τ = 42 days, fatigue (ATL) τ = 7 days, form (TSB) = CTL − ATL.
 * These describe trends in what you did. They are not a diagnosis of fitness,
 * freshness or injury risk.
 */
import { addDaysIso } from "../../dates";

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

export interface LoadInput {
  date: string;
  trimp: number;
  kind: "run" | "other";
}

export interface LoadDay {
  date: string;
  run: number;
  other: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export function loadSeries(items: LoadInput[], from: string, to: string): LoadDay[] {
  const byDay = new Map<string, { run: number; other: number }>();
  for (const i of items) {
    if (i.date < from || i.date > to) continue;
    const d = byDay.get(i.date) ?? { run: 0, other: 0 };
    d[i.kind] += i.trimp;
    byDay.set(i.date, d);
  }
  const kc = 1 - Math.exp(-1 / CTL_DAYS);
  const ka = 1 - Math.exp(-1 / ATL_DAYS);
  let ctl = 0;
  let atl = 0;
  const out: LoadDay[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    const l = byDay.get(d) ?? { run: 0, other: 0 };
    const total = l.run + l.other;
    // form is measured going into the day, before its load
    const tsb = ctl - atl;
    ctl += (total - ctl) * kc;
    atl += (total - atl) * ka;
    out.push({ date: d, run: r1(l.run), other: r1(l.other), ctl: r1(ctl), atl: r1(atl), tsb: r1(tsb) });
  }
  return out;
}

/** Weekly change in CTL over the last 7 days (ramp rate). */
export function rampRate(series: LoadDay[]): number | null {
  if (series.length < 8) return null;
  return r1(series[series.length - 1].ctl - series[series.length - 8].ctl);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
