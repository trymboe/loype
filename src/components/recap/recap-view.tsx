import Link from "next/link";
import clsx from "clsx";
import { Check, ChevronRight, Flag, Minus, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { daysBetween, formatDay } from "@/lib/dates";
import { formatPace } from "@/lib/units";
import { KEY_METRICS, formatChangeDelta, formatChangeValue, type EstimateChange, type EstimateSnapshot, type WeekRecap } from "@/lib/recap/build";

export function weekRange(r: Pick<WeekRecap, "weekStart" | "weekEnd">) {
  const a = formatDay(r.weekStart, { day: "numeric", month: "short" });
  const b = formatDay(r.weekEnd, { day: "numeric", month: "short" });
  return `${a} – ${b}`;
}

const toneOf = (c: EstimateChange | null | undefined) => (!c || c.direction === "same" ? "text-muted" : c.direction === "better" ? "text-good" : "text-warn");

/** The weekly recap: key metrics and how they moved, the week against earlier weeks, and planned vs done. */
export function RecapView({ recap, estimates, today, compact = false }: { recap: WeekRecap; estimates: EstimateSnapshot; today: string; compact?: boolean }) {
  const r = recap;
  const ch = (k: string) => (r.changes ?? []).find((c) => c.key === k) ?? null;
  const others = (r.changes ?? []).filter((c) => !KEY_METRICS.includes(c.key) && c.direction !== "same");
  const vs = r.comparedWith?.weekStart ? `vs week of ${formatDay(r.comparedWith.weekStart, { day: "numeric", month: "short" })}` : null;
  return (
    <div className="space-y-3">
      <section className="card p-5">
        <p className="eyebrow">{weekRange(r)}</p>
        <h2 className="mt-1 text-[1.5rem] leading-tight font-bold tracking-[-0.02em] text-balance">{r.headline}</h2>
        {r.points.length > 0 && <p className="mt-1 text-[0.9375rem] text-muted">{r.points.join(" · ")}</p>}
        {r.caution && (
          <p className="mt-3 flex gap-2 rounded-xl bg-warn/10 p-3 text-[0.8125rem] leading-snug text-warn">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {r.caution}
          </p>
        )}
      </section>

      {estimates.race && <RaceCard race={estimates.race} today={today} predicted={ch("race_goal")} projected={ch("race_projection")} trend={r.raceTrend ?? []} vs={vs} />}

      <section className="card p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="section-title">Key metrics</h3>
          {vs && <span className="text-xs text-muted">{vs}</span>}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4">
          <Metric label="VDOT" value={estimates.vdot ? estimates.vdot.value.toFixed(1) : "–"} change={ch("vdot")} />
          <Metric label="Fitness" value={estimates.ctl != null ? estimates.ctl.toFixed(0) : "–"} change={ch("ctl")} />
          <Metric label="Threshold /km" value={estimates.thresholdPaceS != null ? formatPace(estimates.thresholdPaceS) : "–"} change={ch("threshold_pace")} />
        </div>
      </section>

      <section className="card p-5">
        <h3 className="section-title">Compared with earlier weeks</h3>
        <div className="mt-4 grid grid-cols-3 gap-4">
          <VsAvg label="Distance" value={r.volume.km.toFixed(1)} unit="km" now={r.volume.km} avg={r.typical?.km} />
          <VsAvg label="Time" value={String(r.volume.minutes)} unit="min" now={r.volume.minutes} avg={r.typical?.minutes} />
          <VsAvg label="Runs" value={String(r.volume.runs)} now={r.volume.runs} avg={r.typical?.runs} />
        </div>
        <WeekBars weeks={r.weeklyKm} />
        {r.rank && (
          <p className="mt-2 text-[0.8125rem] font-medium">
            {r.rank.position === 1
              ? `Biggest week in the last ${r.rank.of}`
              : `#${r.rank.position} of the last ${r.rank.of} weeks${r.rank.lastBiggerWeek ? ` · most since ${formatDay(r.rank.lastBiggerWeek, { day: "numeric", month: "short" })}` : ""}`}
          </p>
        )}
      </section>

      {r.plan && r.plan.total > 0 && (
        <section className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="section-title">Planned vs done</h3>
            <span className="text-xs text-muted tabular-nums">
              {r.plan.done}/{r.plan.total}
            </span>
          </div>
          <ul className="mt-3 divide-y divide-[var(--hairline)]">
            {r.plan.sessions.map((s) => (
              <li key={`${s.date}-${s.title}`} className="flex items-center gap-3 py-2.5">
                <StatusIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.9375rem] font-medium">
                    {s.title} {s.key && <Badge tone="accent">Key</Badge>}
                  </p>
                  <p className="text-xs text-muted">{formatDay(s.date)}</p>
                </div>
                <p className="shrink-0 text-right text-[0.8125rem] tabular-nums">
                  {s.actualMin != null ? <span className="font-semibold">{s.actualMin} min</span> : <span className="text-muted">–</span>}
                  <span className="text-muted"> / {s.plannedMin}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!compact && others.length > 0 && (
        <section className="card p-5">
          <h3 className="section-title">Other estimates</h3>
          <ul className="mt-3 divide-y divide-[var(--hairline)]">
            {others.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[0.9375rem] font-medium">{c.label}</p>
                  <p className="text-xs text-muted tabular-nums">
                    {formatChangeValue(c.format, c.before)} → {formatChangeValue(c.format, c.after)}
                  </p>
                </div>
                <span className={clsx("shrink-0 text-[0.8125rem] font-semibold tabular-nums", toneOf(c))}>{formatChangeDelta(c)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {compact && (
        <Link href="/progress/weeks" className="inline-flex items-center gap-0.5 px-1 text-sm font-medium text-accent">
          Estimate history <ChevronRight size={15} />
        </Link>
      )}
    </div>
  );
}

function RaceCard({
  race,
  today,
  predicted,
  projected,
  trend,
  vs,
}: {
  race: NonNullable<EstimateSnapshot["race"]>;
  today: string;
  predicted: EstimateChange | null;
  projected: EstimateChange | null;
  trend: { weekStart: string; timeS: number }[];
  vs: string | null;
}) {
  const days = race.raceDate ? daysBetween(today, race.raceDate) : null;
  const gap = race.predictedS && race.targetTimeS ? race.predictedS - race.targetTimeS : null;
  return (
    <Link href="/plan/race" className="card block p-5 hover:bg-surface-2/40">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow inline-flex min-w-0 items-center gap-1.5 truncate">
          <Flag size={13} className="shrink-0" /> {race.name}
        </p>
        {days != null && days >= 0 && (
          <span className="shrink-0 text-[0.8125rem] font-semibold tabular-nums">
            {days} {days === 1 ? "day" : "days"} to go
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <p className="label">Predicted</p>
          <p className="display mt-1 text-[2.5rem] leading-none">{race.predictedS ? fmtTime(race.predictedS) : "–"}</p>
        </div>
        {predicted && (
          <div className="text-right">
            <p className={clsx("text-[1.125rem] font-bold tabular-nums", toneOf(predicted))}>
              {predicted.direction === "same" ? "Unchanged" : formatChangeDelta(predicted)}
            </p>
            <p className="text-xs text-muted">{vs ?? "vs last week"}</p>
          </div>
        )}
      </div>
      {trend.length >= 2 && <Sparkline points={trend} target={race.targetTimeS} />}
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[var(--hairline)] pt-3 text-[0.8125rem]">
        <div>
          <p className="text-xs text-muted">Target</p>
          <p className="font-semibold tabular-nums">
            {race.targetTimeS ? fmtTime(race.targetTimeS) : "–"}
            {gap != null && <span className={clsx("ml-1.5 font-medium", gap <= 0 ? "text-good" : "text-muted")}>{gap <= 0 ? "on track" : `${fmtTime(gap)} to go`}</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">If you follow the plan</p>
          <p className="font-semibold tabular-nums">
            {race.projectedS ? fmtTime(race.projectedS) : "–"}
            {projected && projected.direction !== "same" && <span className={clsx("ml-1.5 font-medium", toneOf(projected))}>{formatChangeDelta(projected)}</span>}
          </p>
        </div>
      </div>
    </Link>
  );
}

/** Predicted race time per week; lower is better, so faster is drawn higher. */
function Sparkline({ points, target }: { points: { weekStart: string; timeS: number }[]; target: number | null }) {
  const W = 300;
  const H = 56;
  const vals = points.map((p) => p.timeS);
  const lo = Math.min(...vals, ...(target ? [target] : []));
  const hi = Math.max(...vals);
  const span = Math.max(1, hi - lo);
  const x = (i: number) => 4 + (i / (points.length - 1)) * (W - 8);
  const y = (t: number) => 6 + ((t - lo) / span) * (H - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.timeS).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" aria-label="Predicted time, week by week">
        {target && target >= lo && <line x1="0" x2={W} y1={y(target)} y2={y(target)} stroke="currentColor" className="text-subtle" strokeDasharray="3 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(points.length - 1)} cy={y(last.timeS)} r="3.5" fill="var(--accent)" />
      </svg>
      <div className="mt-1 flex justify-between text-[0.6875rem] text-muted tabular-nums">
        <span>
          {formatDay(points[0].weekStart, { day: "numeric", month: "short" })} · {fmtTime(points[0].timeS)}
        </span>
        <span>{target ? `target ${fmtTime(target)}` : ""}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, change }: { label: string; value: string; change: EstimateChange | null }) {
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p className="display mt-1.5 text-[1.375rem] whitespace-nowrap">{value}</p>
      <p className={clsx("mt-0.5 text-xs font-semibold tabular-nums", toneOf(change))}>{change ? (change.direction === "same" ? "Unchanged" : formatChangeDelta(change)) : " "}</p>
    </div>
  );
}

function VsAvg({ label, value, unit, now, avg }: { label: string; value: string; unit?: string; now: number; avg: number | null | undefined }) {
  const pct = avg && avg > 0 ? Math.round(((now - avg) / avg) * 100) : null;
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p className="display mt-1.5 text-[1.375rem] whitespace-nowrap">
        {value}
        {unit && <span className="ml-1 text-[0.75rem] font-medium tracking-normal text-muted">{unit}</span>}
      </p>
      <p className={clsx("mt-0.5 text-xs font-semibold tabular-nums", pct == null || Math.abs(pct) < 5 ? "text-muted" : pct > 0 ? "text-good" : "text-warn")}>
        {pct == null ? " " : Math.abs(pct) < 5 ? "≈ avg" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)} % vs avg`}
      </p>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed")
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-good/14 text-good" aria-label="Done">
        <Check size={15} strokeWidth={2.6} />
      </span>
    );
  if (status === "skipped")
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted" aria-label="Skipped">
        <Minus size={15} strokeWidth={2.6} />
      </span>
    );
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-warn/14 text-warn" aria-label="Missed">
      <X size={15} strokeWidth={2.6} />
    </span>
  );
}

function WeekBars({ weeks }: { weeks: WeekRecap["weeklyKm"] }) {
  const max = Math.max(1, ...weeks.map((w) => w.km));
  return (
    <div className="mt-5">
      <div className="flex h-16 items-end gap-1.5" aria-label="Weekly distance, last 8 weeks">
        {weeks.map((w, i) => (
          <div key={w.weekStart} className="flex h-full flex-1 flex-col justify-end" title={`${formatDay(w.weekStart, { day: "numeric", month: "short" })}: ${w.km} km`}>
            <div
              className={clsx("rounded-t-[4px]", i === weeks.length - 1 ? "bg-accent" : "bg-[color-mix(in_srgb,var(--fg)_14%,transparent)]")}
              style={{ height: `${Math.max(w.km > 0 ? 6 : 2, (w.km / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[0.6875rem] text-muted">
        <span>{weeks[0] ? formatDay(weeks[0].weekStart, { day: "numeric", month: "short" }) : ""}</span>
        <span>km per week</span>
      </div>
    </div>
  );
}
