/**
 * Recovery signals from Garmin wellness data, each compared with your own
 * normal range (never with population norms). Pure.
 *
 *  HRV     7-day mean of ln(overnight HRV) below your 60-day mean by more than
 *          0.5 SD of your daily values: the "smallest worthwhile change" used
 *          in HRV-guided training (Plews et al. 2013; Kiviniemi et al. 2007;
 *          Vesterinen et al. 2016). Weight 2: it can trigger on its own.
 *  RHR     resting HR (or sleeping HR when Garmin has no resting HR) above
 *          your 60-day mean by ≥ 5 bpm and ≥ 1.5 SD on 2 of the last 3 days
 *          (Buchheit 2014). Weight 1.
 *  Sleep   under 6 h on 2 of the last 3 nights; sleep loss lowers endurance
 *          performance and raises perceived effort (Fullagar et al. 2015).
 *          Weight 1.
 *  Body Battery  highest value under 40 on 2 of the last 3 days. Garmin's
 *          own index, not independently validated, so it only supports
 *          other signals. Weight 0.5.
 *
 * A score of 2 or more counts as a fatigue signal. Missing data is never
 * filled in: a metric without at least 14 days of history is skipped.
 */
import { addDaysIso, formatDay } from "../dates";

export interface WellnessPoint {
  date: string;
  metric: string;
  value: number | null;
}

export interface WellnessSignals {
  score: number;
  evidence: string[];
  /** which signals fired, for tests and the UI */
  fired: ("hrv" | "rhr" | "sleep" | "battery")[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

export const SIGNAL_THRESHOLD = 2;

export function wellnessSignals(points: WellnessPoint[], today: string): WellnessSignals {
  const series = (metric: string) =>
    points
      .filter((p) => p.metric === metric && p.value != null && Number.isFinite(p.value) && p.date <= today && p.date > addDaysIso(today, -60))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((p) => ({ date: p.date, v: p.value as number }));
  const last3 = addDaysIso(today, -2);
  const out: WellnessSignals = { score: 0, evidence: [], fired: [] };

  // HRV (ln-transformed, 7-day rolling mean vs 60-day baseline)
  const hrv = series("hrv_overnight_avg").filter((p) => p.v > 0);
  if (hrv.length >= 14) {
    const ln = hrv.map((p) => Math.log(p.v));
    const recent = hrv.filter((p) => p.date > addDaysIso(today, -7)).map((p) => Math.log(p.v));
    if (recent.length >= 3) {
      const base = mean(ln);
      const swc = 0.5 * sd(ln);
      const r = mean(recent);
      if (r < base - swc) {
        out.score += 2;
        out.fired.push("hrv");
        out.evidence.push(`HRV: 7-day average ${Math.round(Math.exp(r))} ms, below your usual ${Math.round(Math.exp(base))} ms (normal range down to ${Math.round(Math.exp(base - swc))} ms)`);
      }
    }
  }

  // resting HR, falling back to average sleeping HR
  const rhrMetric = series("resting_hr").length >= 14 ? "resting_hr" : "sleep_avg_hr";
  const rhr = series(rhrMetric);
  if (rhr.length >= 14) {
    const hist = rhr.filter((p) => p.date < last3).map((p) => p.v);
    if (hist.length >= 10) {
      const m = mean(hist);
      const limit = m + Math.max(5, 1.5 * sd(hist));
      const high = rhr.filter((p) => p.date >= last3 && p.v >= limit);
      if (high.length >= 2) {
        out.score += 1;
        out.fired.push("rhr");
        const label = rhrMetric === "resting_hr" ? "Resting HR" : "Sleeping HR";
        out.evidence.push(`${label}: ${high.map((p) => `${Math.round(p.v)} on ${formatDay(p.date)}`).join(", ")}, above your usual ${Math.round(m)} bpm`);
      }
    }
  }

  // sleep
  const sleep = series("sleep_seconds").filter((p) => p.date >= last3);
  const short = sleep.filter((p) => p.v > 0 && p.v < 6 * 3600);
  if (short.length >= 2) {
    out.score += 1;
    out.fired.push("sleep");
    out.evidence.push(`Sleep: ${short.map((p) => `${(p.v / 3600).toFixed(1)} h on ${formatDay(p.date)}`).join(", ")}`);
  }

  // Body Battery (supporting only)
  const bb = series("body_battery_high").filter((p) => p.date >= last3 && p.v < 40);
  if (bb.length >= 2) {
    out.score += 0.5;
    out.fired.push("battery");
    out.evidence.push(`Body Battery peaked at only ${bb.map((p) => Math.round(p.v)).join(" and ")} on recent days`);
  }
  return out;
}
