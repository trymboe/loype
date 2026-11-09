import Link from "@/components/link";
import clsx from "clsx";
import { CalendarRange, ChevronRight } from "lucide-react";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { weekRange } from "@/components/recap/recap-view";
import { createUserClient } from "@/lib/db/server";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatDay } from "@/lib/dates";
import { formatPace } from "@/lib/units";
import type { EstimateSnapshot, WeekRecap } from "@/lib/recap/build";

export const metadata = { title: "Weekly recaps" };
export const dynamic = "force-dynamic";

interface Row {
  week_start: string;
  estimates: EstimateSnapshot;
  recap: WeekRecap;
}

const pred = (e: EstimateSnapshot, key: string) => e.predictions.find((p) => p.key === key)?.timeS ?? null;

export default async function WeeklyRecapsPage() {
  const db = await createUserClient();
  const { data } = await db.from("weekly_recaps").select("week_start, estimates, recap").order("week_start", { ascending: false }).limit(260);
  const rows = (data ?? []) as Row[];
  if (!rows.length) {
    return (
      <>
        <PageHeader back={{ href: "/progress", label: "Progress" }} title="Weekly recaps" />
        <EmptyState icon={<CalendarRange size={22} />} title="No recaps yet" />
      </>
    );
  }
  const race = rows.find((r) => r.estimates.race)?.estimates.race ?? null;
  const cols: { label: string; get: (e: EstimateSnapshot) => number | null; fmt: (v: number) => string; higherIsBetter: boolean }[] = [
    { label: "VDOT", get: (e) => e.vdot?.value ?? null, fmt: (v) => v.toFixed(1), higherIsBetter: true },
    ...(race
      ? [{ label: race.name, get: (e: EstimateSnapshot) => (e.race && Math.abs(e.race.distanceM - race.distanceM) < 1 ? e.race.predictedS : null), fmt: fmtTime, higherIsBetter: false }]
      : []),
    { label: "5 km", get: (e) => pred(e, "5k"), fmt: fmtTime, higherIsBetter: false },
    { label: "10 km", get: (e) => pred(e, "10k"), fmt: fmtTime, higherIsBetter: false },
    { label: "Half", get: (e) => pred(e, "half"), fmt: fmtTime, higherIsBetter: false },
    { label: "Threshold", get: (e) => e.thresholdPaceS, fmt: (v) => formatPace(v), higherIsBetter: false },
    { label: "Fitness", get: (e) => e.ctl, fmt: (v) => v.toFixed(1), higherIsBetter: true },
  ];

  return (
    <>
      <PageHeader back={{ href: "/progress", label: "Progress" }} title="Weekly recaps" />
      <div className="stagger space-y-3">
        <Card className="px-0 pb-3">
          <CardHeader title="Estimate history" className="px-5" />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-[0.8125rem] tabular-nums">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-2 pr-3 pl-5 font-medium">Week</th>
                  {cols.map((c) => (
                    <th key={c.label} className="max-w-28 truncate px-2 py-2 text-right font-medium">
                      {c.label}
                    </th>
                  ))}
                  <th className="py-2 pr-5 pl-2 text-right font-medium">km</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline)]">
                {rows.map((r, i) => {
                  const older = rows[i + 1]?.estimates ?? null;
                  return (
                    <tr key={r.week_start}>
                      <td className="py-2 pr-3 pl-5 whitespace-nowrap">
                        <Link href={`/progress/weeks/${r.week_start}`} className="font-medium text-accent">
                          {formatDay(r.week_start, { day: "numeric", month: "short", year: "2-digit" })}
                        </Link>
                      </td>
                      {cols.map((c) => {
                        const v = c.get(r.estimates);
                        const b = older ? c.get(older) : null;
                        const up = v != null && b != null && Math.abs(v - b) > 1e-6 ? (v > b) === c.higherIsBetter : null;
                        return (
                          <td key={c.label} className={clsx("px-2 py-2 text-right whitespace-nowrap", up === true && "text-good", up === false && "text-warn")}>
                            {v != null ? c.fmt(v) : "–"}
                          </td>
                        );
                      })}
                      <td className="py-2 pr-5 pl-2 text-right">{r.recap.volume.km.toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="py-2">
          <ul className="divide-y divide-[var(--hairline)]">
            {rows.map((r) => (
              <li key={r.week_start}>
                <Link href={`/progress/weeks/${r.week_start}`} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted">{weekRange(r.recap)}</p>
                    <p className="truncate text-[0.9375rem] font-medium">{r.recap.headline}</p>
                  </div>
                  <span className="shrink-0 text-[0.8125rem] text-muted tabular-nums">{r.recap.volume.km.toFixed(1)} km</span>
                  <ChevronRight size={18} className="shrink-0 text-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
