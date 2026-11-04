import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, Flag, Lightbulb, Sparkles, TriangleAlert } from "lucide-react";
import { Badge, Card, CardHeader, Stat } from "@/components/ui";
import { fmtDist, fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatDay } from "@/lib/dates";
import { formatPace } from "@/lib/units";
import type { Insight } from "@/lib/progress/insight";
import type { RaceGoalInfo } from "@/lib/race/goal";
import type { RaceStatus } from "@/lib/race/status";
import type { CompactOutput } from "@/lib/fitness/service";

const INSIGHT_STYLE = {
  good: { icon: Sparkles, cls: "text-good bg-good/12" },
  warn: { icon: TriangleAlert, cls: "text-warn bg-warn/12" },
  info: { icon: Lightbulb, cls: "text-accent bg-accent/12" },
};

export function InsightCard({ insight }: { insight: Insight }) {
  const { icon: Icon, cls } = INSIGHT_STYLE[insight.tone];
  return (
    <Link href={insight.href} className="card flex items-start gap-3.5 p-4 hover:bg-surface-2/40">
      <span className={clsx("flex size-9 shrink-0 items-center justify-center rounded-[0.625rem]", cls)}>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Latest insight</p>
        <p className="mt-0.5 text-[0.9375rem] leading-snug font-semibold">{insight.title}</p>
        <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">{insight.body}</p>
      </div>
      <span className="mt-5 inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-accent">
        {insight.cta} <ChevronRight size={14} />
      </span>
    </Link>
  );
}

export function RaceGoalCard({ goal, status, week }: { goal: RaceGoalInfo; status: RaceStatus; week: { index: number; total: number } | null }) {
  const p = status.prediction;
  const pct = week ? Math.min(100, ((week.index + 1) / week.total) * 100) : null;
  return (
    <Card href="/plan/race">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Flag size={13} /> {fmtDist(goal.distanceM)}
          {goal.raceDate ? ` · ${formatDay(goal.raceDate, { day: "numeric", month: "short" })}` : ""}
        </p>
        <ChevronRight size={18} className="shrink-0 text-subtle" />
      </div>
      <p className="mt-1 truncate text-[1.375rem] leading-tight font-semibold tracking-[-0.02em]">{goal.name}</p>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat size="sm" label="Race day" value={status.past ? "Done" : status.daysToGo} unit={status.past ? undefined : status.daysToGo === 1 ? "day" : "days"} />
        <Stat size="sm" label="Predicted" value={p ? fmtTime(p.timeS) : "–"} />
        <Stat size="sm" label="Target" value={goal.targetTimeS ? fmtTime(goal.targetTimeS) : "–"} />
      </div>
      {!status.past && <p className="mt-3 text-[0.8125rem] leading-snug text-muted">{status.headline}</p>}
      {pct != null && !status.past && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Week {week!.index + 1} of {week!.total} of the plan
          </p>
        </div>
      )}
    </Card>
  );
}

export function FitnessSnapshotCard({ out }: { out: CompactOutput }) {
  const e = out.estimate;
  const last = out.load[out.load.length - 1];
  return (
    <Card href="/progress">
      <CardHeader
        title="Fitness snapshot"
        aside={
          <span className="inline-flex items-center gap-1.5">
            <Badge>Estimated</Badge>
            <ChevronRight size={14} className="text-subtle" />
          </span>
        }
      />
      {e.withheld ? (
        <p className="mt-2 text-sm text-muted">{e.reason}</p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-4">
          <Stat size="md" label="VDOT" value={e.vdot.toFixed(1)} hint={`${e.lower.toFixed(1)}–${e.upper.toFixed(1)}`} />
          <Stat size="md" label="Threshold" value={out.threshold ? formatPace(out.threshold.paceSPerKm) : "–"} unit="/km" hint={out.threshold?.hr ? `~${out.threshold.hr} bpm` : undefined} />
          <Stat
            size="md"
            label="Form"
            value={last ? `${last.tsb > 0 ? "+" : ""}${last.tsb.toFixed(0)}` : "–"}
            hint={last ? (last.tsb >= 5 ? "fresh" : last.tsb <= -20 ? "tired" : "training") : undefined}
          />
        </div>
      )}
    </Card>
  );
}
