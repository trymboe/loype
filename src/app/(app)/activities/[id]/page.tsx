import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Info } from "lucide-react";
import { ActivityExplorer, type LapView } from "@/components/activity/explorer";
import { FeedbackForm } from "@/components/activity/feedback-form";
import { Badge, Stat } from "@/components/ui";
import { buildChartSeries } from "@/lib/analytics/series";
import { getActivityDetail } from "@/lib/db/queries";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatKm, formatPace, formatPaceFromSpeed } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [detail, tz] = await Promise.all([getActivityDetail(id), userTimezone()]);
  if (!detail) notFound();
  const { activity: a, streams, laps, splits, feedback } = detail;

  const points = streams ? buildChartSeries(streams) : [];
  const lapViews: LapView[] = laps.map((l: any) => ({
    index: l.lap_index,
    startT: l.start_offset_s,
    endT: l.start_offset_s + (l.elapsed_s ?? 0),
    distanceM: l.distance_m,
    timerS: l.timer_s,
    avgSpeed: l.avg_speed ?? (l.distance_m && l.timer_s ? l.distance_m / l.timer_s : null),
    avgHr: l.avg_hr,
    maxHr: l.max_hr,
    avgCadence: l.avg_cadence,
    intensity: l.intensity,
  }));
  const flags: { code: string; severity: string; message: string }[] = a.quality?.flags ?? [];
  const prov: Record<string, string> = a.provenance ?? {};
  const fullPaces: number[] = splits.filter((s: any) => !s.partial && s.pace_s_per_km).map((s: any) => s.pace_s_per_km);
  // runs shorter than 1 km have no full split: compare against the partial one instead of Infinity
  const fastestSplit = fullPaces.length ? Math.min(...fullPaces) : (splits[0]?.pace_s_per_km ?? null);

  return (
    <>
      <Link href="/activities" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft size={16} /> Activities
      </Link>
      <header className="mb-5">
        <p className="label">
          {formatDay(a.local_date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · {localTime(a.start_time, a.utc_offset_s, tz)}
        </p>
        <h1 className="font-display text-4xl font-bold tracking-tight">{a.name ?? "Run"}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {a.is_indoor && <Badge>Indoor</Badge>}
          {a.sub_sport && a.sub_sport !== "generic" && <Badge>{a.sub_sport.replace(/_/g, " ")}</Badge>}
          {!a.usable_for_fitness && <Badge tone="warn">Not used as fitness evidence</Badge>}
        </div>
      </header>

      <section className="card rise mb-4 grid grid-cols-2 gap-x-4 gap-y-5 p-5 sm:grid-cols-4">
        <Stat label="Distance" value={formatKm(a.distance_m)} unit="km" />
        <Stat label="Moving time" value={formatDuration(a.moving_s)} hint={a.elapsed_s ? `${formatDuration(a.elapsed_s)} elapsed` : undefined} />
        <Stat label="Avg pace" value={formatPaceFromSpeed(a.avg_speed_moving)} unit="/km" hint="moving time" />
        <Stat label="Avg HR" value={a.avg_hr ? Math.round(a.avg_hr) : "–"} unit="bpm" hint={a.max_hr ? `max ${Math.round(a.max_hr)}` : undefined} />
        <Stat label="Cadence" value={a.avg_cadence ? Math.round(a.avg_cadence) : "–"} unit="spm" />
        <Stat label="Elevation" value={a.elevation_gain_m != null ? Math.round(a.elevation_gain_m) : "–"} unit="m gain" />
        <Stat label="Device" value={<span className="text-base">{a.device_product ?? a.device_manufacturer ?? "–"}</span>} />
        <Stat label="Data quality" value={a.quality_score != null ? `${Math.round(a.quality_score * 100)}` : "–"} unit="/ 100" />
      </section>

      {flags.length > 0 && (
        <section className="card mb-4 space-y-2 p-4">
          {flags.map((f) => (
            <p key={f.code} className="flex gap-2 text-sm">
              <Info size={16} className={f.severity === "info" ? "mt-0.5 shrink-0 text-muted" : "mt-0.5 shrink-0 text-warn"} />
              <span>{f.message}</span>
            </p>
          ))}
        </section>
      )}

      {points.length > 0 ? (
        <ActivityExplorer points={points} laps={lapViews} />
      ) : (
        <p className="card p-5 text-sm text-muted">No time-series data was recorded for this activity.</p>
      )}

      {splits.length > 0 && (
        <section className="card mt-4 overflow-hidden">
          <h2 className="label px-4 pt-4">Splits · per km</h2>
          <table className="tabular mt-2 w-full text-sm">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Km</th>
                <th className="py-2 font-medium">Pace</th>
                <th className="w-1/3 py-2 font-medium" />
                <th className="py-2 font-medium">HR</th>
                <th className="py-2 pr-4 font-medium">Elev</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((s: any) => {
                const rel = s.pace_s_per_km && fastestSplit ? fastestSplit / s.pace_s_per_km : 0;
                return (
                  <tr key={s.split_index} className="border-t border-border">
                    <td className="px-4 py-2 text-muted">{s.partial ? (s.distance_m / 1000).toFixed(2) : s.split_index + 1}</td>
                    <td className={s.pace_s_per_km === fastestSplit ? "font-semibold text-accent" : "font-semibold"}>{formatPace(s.pace_s_per_km)}</td>
                    <td className="pr-3">
                      <div className="h-1.5 rounded-full bg-accent/70" style={{ width: `${Math.max(4, rel * 100)}%` }} />
                    </td>
                    <td>{s.avg_hr ? Math.round(s.avg_hr) : "–"}</td>
                    <td className="pr-4 text-muted">
                      {s.elevation_gain_m != null ? `+${Math.round(s.elevation_gain_m)}` : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <div className="mt-4">
        <FeedbackForm activityId={a.id} initial={feedback} />
      </div>

      <details className="mt-4 rounded-2xl px-1 text-xs text-muted">
        <summary className="cursor-pointer">How these numbers were produced</summary>
        <ul className="mt-2 space-y-1 pl-4">
          {Object.entries(prov).map(([k, v]) => (
            <li key={k}>
              <span className="font-medium text-fg">{k}</span>: {v === "device" ? "measured by your watch" : "calculated by Løype from the recorded samples"}
            </li>
          ))}
          <li>Moving time excludes timer pauses and standing still (speed below 0.8 m/s).</li>
          <li>Splits are interpolated at each kilometre from the distance stream.</li>
          <li>Methods: {Object.values(a.derivation_versions ?? {}).join(", ")}</li>
        </ul>
      </details>
    </>
  );
}
