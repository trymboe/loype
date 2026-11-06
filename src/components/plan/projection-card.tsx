import { Card, CardHeader } from "@/components/ui";
import { fmtTime } from "@/lib/analytics/fitness/estimate";
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
          {fmtTime(Math.abs(delta))} {delta < 0 ? "ahead of" : "behind"} the projection at plan start ({fmtTime(start.projectedS)})
        </p>
      )}
    </Card>
  );
}
