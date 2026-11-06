import Link from "next/link";
import clsx from "clsx";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronRight, Flag, Minus, TriangleAlert, X } from "lucide-react";
import { Badge, Stat } from "@/components/ui";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatDay } from "@/lib/dates";
import { PHASE_LABEL } from "@/lib/planning/types";
import { ADJUSTED_BY, formatChangeDelta, formatChangeValue, type EstimateChange, type EstimateSnapshot, type WeekRecap } from "@/lib/recap/build";

export function weekRange(r: Pick<WeekRecap, "weekStart" | "weekEnd">) {
  const a = formatDay(r.weekStart, { day: "numeric", month: "short" });
  const b = formatDay(r.weekEnd, { day: "numeric", month: "short" });
  return `${a} – ${b}`;
}

/** The weekly recap: how the week went, the plan, and which estimates moved. Used in the first-visit dialog and on its own page. */
export function RecapView({ recap, estimates, compact = false }: { recap: WeekRecap; estimates: EstimateSnapshot; compact?: boolean }) {
  const r = recap;
  const moved = r.changes.filter((c) => c.direction !== "same");
  const same = r.changes.filter((c) => c.direction === "same");
  return (
    <div className="space-y-3">
      <section className="card p-5">
        <p className="eyebrow">Week {weekRange(r)}</p>
        <h2 className="mt-1 text-[1.625rem] leading-tight font-bold tracking-[-0.02em] text-balance">{r.headline}</h2>
        {r.points.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-[0.9375rem] leading-snug">
            {r.points.map((p) => (
              <li key={p} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        )}
        {r.caution && (
          <p className="mt-4 flex gap-2 rounded-xl bg-warn/10 p-3 text-[0.8125rem] leading-snug text-warn">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {r.caution}
          </p>
        )}
      </section>

      <section className="card p-5">
        <h3 className="section-title">How the week went</h3>
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4">
          <Stat size="md" label="Runs" value={r.volume.runs} hint={r.typical ? `usual ${r.typical.runs}` : undefined} />
          <Stat size="md" label="Time" value={r.volume.minutes} unit="min" hint={r.plan?.targetMinutes ? `plan ${r.plan.targetMinutes} min` : r.typical ? `usual ${r.typical.minutes} min` : undefined} />
          <Stat size="md" label="Distance" value={r.volume.km.toFixed(1)} unit="km" hint={r.typical ? `usual ${r.typical.km.toFixed(1)} km` : undefined} />
          <Stat size="md" label="Longest" value={r.volume.longestKm.toFixed(1)} unit="km" />
        </div>
        <WeekBars weeks={r.weeklyKm} />
      </section>

      {r.plan && r.plan.total > 0 && (
        <section className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="section-title">Planned vs done</h3>
            <span className="text-xs text-muted">
              {r.plan.totalWeeks ? `Week ${r.plan.weekIndex + 1} of ${r.plan.totalWeeks} · ` : ""}
              {PHASE_LABEL[r.plan.phase]}
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

      {(r.adjustments.length > 0 || r.next) && (
        <section className="card p-5">
          <h3 className="section-title">Your plan</h3>
          {r.adjustments.length > 0 ? (
            <ul className="mt-3 space-y-2.5">
              {r.adjustments.map((a) => (
                <li key={a.at} className="text-[0.875rem] leading-snug">
                  <span className="text-xs font-semibold text-muted">
                    {ADJUSTED_BY[a.by] ?? a.by} · {formatDay(a.at.slice(0, 10))}
                  </span>
                  <p className="mt-0.5">{a.reason}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[0.875rem] text-muted">No changes to the plan this week.</p>
          )}
          {r.next && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3.5">
              <div className="min-w-0">
                <p className="text-xs text-muted">
                  Next week · {PHASE_LABEL[r.next.phase]}
                </p>
                <p className="mt-0.5 text-[0.9375rem] font-semibold">
                  {r.next.targetMinutes} min · {r.next.sessions} run{r.next.sessions === 1 ? "" : "s"}
                  {r.next.longestMin > 0 && <span className="font-normal text-muted"> · longest {r.next.longestMin} min</span>}
                </p>
              </div>
              <Trend minutes={r.next.changeMinutes} />
            </div>
          )}
        </section>
      )}

      {estimates.race && <RaceRow race={estimates.race} change={r.changes.find((c) => c.key === "race_goal") ?? null} />}

      <section className="card p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="section-title">Estimates</h3>
          {r.comparedWith && (
            <span className="text-xs text-muted">
              vs {r.comparedWith.weekStart ? `week of ${formatDay(r.comparedWith.weekStart, { day: "numeric", month: "short" })}` : "last week"}
            </span>
          )}
        </div>
        {r.changes.length === 0 ? (
          <p className="mt-2 text-[0.875rem] leading-snug text-muted">{estimates.vdot ? `VDOT ${estimates.vdot.value.toFixed(1)} · first snapshot` : "No fitness estimate yet"}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--hairline)]">
            {[...moved, ...(compact ? [] : same)].map((c) => (
              <ChangeRow key={c.key} c={c} />
            ))}
          </ul>
        )}
        {compact && same.length > 0 && <p className="mt-2 text-xs text-muted">{same.length} more unchanged.</p>}
        {compact && (
          <Link href="/progress/weeks" className="mt-3 inline-flex items-center gap-0.5 text-sm font-medium text-accent">
            Estimate history <ChevronRight size={15} />
          </Link>
        )}
      </section>
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

function Trend({ minutes }: { minutes: number }) {
  const Icon = minutes > 5 ? ArrowUpRight : minutes < -5 ? ArrowDownRight : ArrowRight;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[0.8125rem] font-semibold text-muted">
      <Icon size={16} />
      {Math.abs(minutes) > 5 ? `${minutes > 0 ? "+" : "−"}${Math.abs(minutes)} min` : "Steady"}
    </span>
  );
}

function ChangeRow({ c }: { c: EstimateChange }) {
  const tone = c.direction === "better" ? "text-good" : c.direction === "worse" ? "text-warn" : "text-muted";
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] font-medium">{c.label}</p>
        <p className="text-xs text-muted tabular-nums">
          {formatChangeValue(c.format, c.before)} → {formatChangeValue(c.format, c.after)}
        </p>
      </div>
      <span className={clsx("shrink-0 text-[0.8125rem] font-semibold tabular-nums", tone)}>{c.direction === "same" ? "Unchanged" : formatChangeDelta(c)}</span>
    </li>
  );
}

function RaceRow({ race, change }: { race: NonNullable<EstimateSnapshot["race"]>; change: EstimateChange | null }) {
  return (
    <Link href="/plan/race" className="card flex items-center gap-3.5 p-4 hover:bg-surface-2/40">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-accent/12 text-accent">
        <Flag size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="eyebrow truncate">
          {race.name}
          {race.raceDate ? ` · ${formatDay(race.raceDate, { day: "numeric", month: "short" })}` : ""}
        </p>
        <p className="mt-0.5 text-[0.9375rem] font-semibold">
          Predicted {race.predictedS ? fmtTime(race.predictedS) : "–"}
          {race.projectedS && <span className="font-normal text-muted"> · on plan {fmtTime(race.projectedS)}</span>}
          {race.targetTimeS && <span className="font-normal text-muted"> · target {fmtTime(race.targetTimeS)}</span>}
        </p>
        {change && change.direction !== "same" && (
          <p className={clsx("text-xs font-semibold", change.direction === "better" ? "text-good" : "text-warn")}>
            {formatChangeDelta(change)} since last week
          </p>
        )}
      </div>
      <ChevronRight size={18} className="shrink-0 text-subtle" />
    </Link>
  );
}

function WeekBars({ weeks }: { weeks: WeekRecap["weeklyKm"] }) {
  const max = Math.max(1, ...weeks.map((w) => w.km));
  return (
    <div className="mt-5">
      <p className="label mb-2">Last 8 weeks</p>
      <div className="flex h-16 items-end gap-1.5" aria-label="Weekly distance, last 8 weeks">
        {weeks.map((w, i) => (
          <div key={w.weekStart} className="flex h-full flex-1 flex-col justify-end" title={`${formatDay(w.weekStart, { day: "numeric", month: "short" })}: ${w.km} km`}>
            <div
              className={clsx("rounded-t-[4px]", i === weeks.length - 1 ? "bg-accent" : "bg-surface-2")}
              style={{ height: `${Math.max(w.km > 0 ? 6 : 2, (w.km / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
