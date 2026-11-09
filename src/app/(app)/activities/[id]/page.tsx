import { notFound } from "next/navigation";
import { Download, Info, Map as MapIcon } from "lucide-react";
import { saveActivityAsRouteAction } from "@/app/(app)/routes/actions";
import { ActivityExplorer, type LapView } from "@/components/activity/explorer";
import { AnalysisCard } from "@/components/activity/analysis-card";
import { CoachCheckin } from "@/components/activity/coach-checkin";
import { FeedbackForm } from "@/components/activity/feedback-form";
import { ShoeSelect } from "@/components/shoes/shoe-select";
import { Badge, PageHeader, Stat } from "@/components/ui";
import { buildChartSeries } from "@/lib/analytics/series";
import { isKeySession } from "@/lib/coach/checkin";
import { coachConfigured } from "@/lib/coach/service";
import { getActivityDetail, getActivityFeatures, getActivityScore } from "@/lib/db/queries";
import { createUserClient } from "@/lib/db/server";
import { formatDay, localTime } from "@/lib/dates";
import { formatDuration, formatKm, formatPace, formatPaceFromSpeed } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";
import { SubmitButton } from "@/components/feedback/submit-button";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [detail, tz, score, features, planned] = await Promise.all([
    getActivityDetail(id),
    userTimezone(),
    getActivityScore(id),
    getActivityFeatures(id),
    coachConfigured() ? createUserClient().then((db) => db.from("planned_workouts").select("type, key").eq("activity_id", id).maybeSingle()) : null,
  ]);
  if (!detail) notFound();
  const { activity: a, streams, laps, splits, feedback } = detail;
  const checkin = a.sport === "running" && planned?.data && isKeySession(planned.data);

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
  const fullPaces: number[] = splits.filter((s: any) => !s.partial && s.pace_s_per_km).map((s: any) => s.pace_s_per_km);
  // runs shorter than 1 km have no full split: compare against the partial one instead of Infinity
  const fastestSplit = fullPaces.length ? Math.min(...fullPaces) : (splits[0]?.pace_s_per_km ?? null);
  const slowestSplit = fullPaces.length ? Math.max(...fullPaces) : fastestSplit;
  // bar length: 35 % for the slowest full split up to 100 % for the fastest, so differences are visible
  const splitBar = (pace: number | null) =>
    !pace || !fastestSplit || !slowestSplit ? 0 : slowestSplit === fastestSplit ? 100 : Math.max(8, 35 + (65 * (slowestSplit - pace)) / (slowestSplit - fastestSplit));

  return (
    <>
      <PageHeader
        back={{ href: "/activities", label: "Activities" }}
        eyebrow={`${formatDay(a.local_date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${localTime(a.start_time, a.utc_offset_s, tz)}`}
        title={a.name ?? "Run"}
        subtitle={
          a.is_indoor || (a.sub_sport && a.sub_sport !== "generic") || !a.usable_for_fitness ? (
            <span className="mt-1 flex flex-wrap gap-1.5">
              {a.is_indoor && <Badge>Indoor</Badge>}
              {a.sub_sport && a.sub_sport !== "generic" && <Badge>{a.sub_sport.replace(/_/g, " ")}</Badge>}
              {!a.usable_for_fitness && <Badge tone="warn">Not used as fitness evidence</Badge>}
            </span>
          ) : undefined
        }
      />

      <section className="card rise mb-3 overflow-hidden">
        <div className="grid grid-cols-3 gap-4 p-5">
          <Stat label="Distance" value={formatKm(a.distance_m)} unit="km" />
          <Stat label="Moving time" value={formatDuration(a.moving_s)} hint={a.elapsed_s ? `${formatDuration(a.elapsed_s)} elapsed` : undefined} />
          <Stat label="Avg pace" value={formatPaceFromSpeed(a.avg_speed_moving)} unit="/km" />
        </div>
        <div className="grid grid-cols-3 gap-x-4 gap-y-4 border-t border-[var(--hairline)] bg-surface-2/40 px-5 py-4 sm:grid-cols-5">
          <Stat size="sm" label="Avg HR" value={a.avg_hr ? Math.round(a.avg_hr) : "–"} unit="bpm" hint={a.max_hr ? `max ${Math.round(a.max_hr)}` : undefined} />
          <Stat size="sm" label="Cadence" value={a.avg_cadence ? Math.round(a.avg_cadence) : "–"} unit="spm" />
          <Stat size="sm" label="Elevation" value={a.elevation_gain_m != null ? `+${Math.round(a.elevation_gain_m)}` : "–"} unit="m" />
          <Stat size="sm" label="Data quality" value={a.quality_score != null ? `${Math.round(a.quality_score * 100)}` : "–"} unit="/ 100" />
          <Stat size="sm" label="Device" value={<span className="text-[0.9375rem] font-semibold tracking-normal capitalize">{deviceLabel(a.device_manufacturer, a.device_product)}</span>} />
        </div>
      </section>

      {flags.length > 0 && (
        <section className="card mb-3 space-y-2.5 p-4">
          {flags.map((f) => (
            <p key={f.code} className="flex gap-2.5 text-[0.8125rem] leading-snug text-fg-2">
              <Info size={16} className={f.severity === "info" ? "mt-px shrink-0 text-muted" : "mt-px shrink-0 text-warn"} />
              <span>{f.message}</span>
            </p>
          ))}
        </section>
      )}

      {checkin && <CoachCheckin activityId={a.id} feedbackKey={[feedback?.rpe, feedback?.legs, feedback?.discomfort, feedback?.notes].map((v) => v ?? "").join("|")} />}

      {a.sport === "running" && <AnalysisCard activityId={a.id} score={score} features={features} override={a.classification_override ?? null} />}
      {a.sport === "running" && <ShoeSelect activityId={a.id} shoeId={a.shoe_id ?? null} />}

      {points.length > 0 ? (
        <ActivityExplorer points={points} laps={lapViews} />
      ) : (
        <p className="card p-5 text-sm text-muted">No time-series data was recorded for this activity.</p>
      )}

      {splits.length > 0 && (
        <section className="card mt-3 overflow-hidden">
          <h2 className="section-title px-5 pt-5">Splits</h2>
          <table className="tabular mt-3 w-full text-sm">
            <thead className="text-left text-[0.6875rem] text-muted">
              <tr>
                <th className="py-2 pl-5 font-medium">Km</th>
                <th className="py-2 font-medium">Pace</th>
                <th className="w-[38%] py-2 font-medium" />
                <th className="py-2 text-right font-medium">HR</th>
                <th className="py-2 pr-5 text-right font-medium">Elev</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((s: any) => {
                return (
                  <tr key={s.split_index} className="border-t border-[var(--hairline)]">
                    <td className="py-2.5 pl-5 text-muted">{s.partial ? (s.distance_m / 1000).toFixed(2) : s.split_index + 1}</td>
                    <td className={s.pace_s_per_km === fastestSplit ? "font-semibold text-accent" : "font-semibold"}>{formatPace(s.pace_s_per_km)}</td>
                    <td className="pr-4">
                      <div
                        className={s.pace_s_per_km === fastestSplit ? "h-2 rounded-full bg-accent" : "h-2 rounded-full bg-pace/70"}
                        style={{ width: `${Math.min(100, splitBar(s.pace_s_per_km))}%` }}
                      />
                    </td>
                    <td className="text-right">{s.avg_hr ? Math.round(s.avg_hr) : "–"}</td>
                    <td className="pr-5 text-right text-muted">
                      {s.elevation_gain_m != null ? `+${Math.round(s.elevation_gain_m)}` : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {a.has_gps && (
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={saveActivityAsRouteAction.bind(null, a.id)}>
            <SubmitButton className="btn btn-secondary btn-sm">
              <MapIcon size={16} /> Save as route
            </SubmitButton>
          </form>
          <a href={`/api/activities/${a.id}/gpx`} className="btn btn-secondary btn-sm" download>
            <Download size={16} /> Export GPX
          </a>
        </div>
      )}

      <div className="mt-3">
        <FeedbackForm activityId={a.id} initial={feedback} />
      </div>

    </>
  );
}

/** "vivoactive5" stays, a bare product number ("1") falls back to the manufacturer. */
function deviceLabel(manufacturer: string | null, product: string | null): string {
  if (product && !/^\d+$/.test(product)) return product.replace(/_/g, " ");
  return manufacturer ?? product ?? "–";
}
