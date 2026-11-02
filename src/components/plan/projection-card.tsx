import { Card, CardHeader } from "@/components/ui";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
import { formatDay } from "@/lib/dates";
import type { Projection } from "@/lib/planning/projection";

/** "Follow this plan: 10 km X → Y", with the plan-start projection and today's update. */
export function ProjectionCard({ start, live, target }: { start: Projection; live: Projection | null; target: number | null }) {
  const now = live ?? start;
  const delta = live ? live.projectedS - start.projectedS : 0;
  return (
    <Card>
      <CardHeader title="If you follow this plan" aside="Estimate" />
      <div className="mt-3 flex items-baseline gap-3">
        <span className="tabular font-display text-2xl font-semibold text-muted">{fmtTime(now.nowS)}</span>
        <span className="text-muted">→</span>
        <span className="tabular font-display text-4xl font-bold">{fmtTime(now.projectedS)}</span>
        <span className="text-sm text-muted">{now.label}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Likely range {fmtTime(now.slowS)} – {fmtTime(now.fastS)}
        {target ? ` · your target ${fmtTime(target)}` : ""}
      </p>
      {live && Math.abs(delta) >= 5 && (
        <p className="mt-3 text-sm">
          {delta < 0 ? "Ahead of" : "Behind"} the projection at the start ({fmtTime(start.projectedS)}) by {fmtTime(Math.abs(delta))}, based on your fitness now and the sessions you have done.
        </p>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer font-medium text-accent">How this is estimated</summary>
        <p className="mt-2 leading-relaxed">
          From your fitness estimate (VDOT {now.vdotNow.toFixed(1)}) plus typical gains for your level over the remaining {now.trainingWeeks} training weeks, with diminishing returns, scaled
          by how much the plan raises your running and by how many recent sessions you completed. It is a heuristic, not a promise: a race or time trial gives the real answer.
          Updated {formatDay(now.asOf)}.
        </p>
      </details>
    </Card>
  );
}
