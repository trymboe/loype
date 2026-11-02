import { setClassification } from "@/app/(app)/activities/[id]/actions";
import { Badge, Stat } from "@/components/ui";
import { fmtDist } from "@/lib/analytics/fitness/estimate";
import { RUN_CLASS_LABEL, type RunClass } from "@/lib/analytics/fitness/scoring";
import { formatDuration } from "@/lib/units";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CLASS_COLOR: Partial<Record<RunClass, string>> = {
  recovery: "var(--easy)",
  easy: "var(--easy)",
  long: "var(--long)",
  steady: "var(--tempo)",
  threshold: "var(--tempo)",
  intervals: "var(--intervals)",
  race: "var(--intervals)",
};
const ZONE_COLORS = ["var(--elev)", "var(--easy)", "var(--accent)", "var(--tempo)", "var(--warn)", "var(--intervals)"];

export function AnalysisCard({ activityId, score, features, override }: { activityId: string; score: any | null; features: any | null; override: string | null }) {
  if (!score) {
    return (
      <section className="card mb-4 p-5 text-sm text-muted">
        <p className="label mb-1">Analysis</p>
        Workout type, training load and efficiency appear after the fitness model has run (it runs after each sync, or when you open Progress).
      </section>
    );
  }
  const cls = score.classification as RunClass;
  const zones: number[] | null = score.zone_seconds;
  const zoneTotal = zones ? zones.reduce((a, b) => a + b, 0) : 0;
  const efforts: any[] = (features?.bestEfforts ?? []).filter((e: any) => e.distanceM >= 1000);

  return (
    <section className="card rise mb-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label">Analysis</p>
        <span className="text-[11px] text-muted">fitness@1</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full px-3 py-1 text-sm font-semibold text-bg" style={{ background: CLASS_COLOR[cls] ?? "var(--muted)" }}>
          {RUN_CLASS_LABEL[cls]}
        </span>
        <Badge tone="muted">{override ? "set by you" : `auto · ${Math.round((score.classification_confidence ?? 0) * 100)} % sure`}</Badge>
      </div>
      {score.classification_reasons?.length > 0 && <p className="mt-1.5 text-xs text-muted">{score.classification_reasons.join(" · ")}</p>}
      <form action={setClassification} className="mt-2 flex items-center gap-2 text-xs">
        <input type="hidden" name="activityId" value={activityId} />
        <select name="classification" defaultValue={override ?? ""} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5">
          <option value="">Automatic</option>
          {(Object.keys(RUN_CLASS_LABEL) as RunClass[])
            .filter((c) => c !== "unknown")
            .map((c) => (
              <option key={c} value={c}>
                {RUN_CLASS_LABEL[c]}
              </option>
            ))}
        </select>
        <button className="rounded-lg bg-surface-2 px-2.5 py-1.5 font-semibold">Save type</button>
      </form>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        <Stat
          label="Training load"
          value={score.trimp != null ? Math.round(score.trimp) : "–"}
          unit="TRIMP"
          hint={score.trimp_method === "pace_estimate" ? "estimated from pace (HR unreliable)" : "from heart rate"}
        />
        <Stat
          label="Intensity"
          value={score.intensity != null ? `${Math.round(score.intensity * 100)}` : "–"}
          unit="% HRR"
          hint={score.intensity_source === "pace" ? "estimated from pace" : "heart-rate reserve, steady part"}
        />
        <Stat label="Efficiency" value={score.ef != null ? score.ef.toFixed(2) : "–"} hint="m/min per bpm" />
        <Stat
          label="HR drift"
          value={score.decoupling_pct != null ? `${score.decoupling_pct > 0 ? "+" : ""}${score.decoupling_pct.toFixed(1)}` : "–"}
          unit="%"
          hint={score.decoupling_pct == null ? "needs 25+ min steady" : score.decoupling_pct > 5 ? "notable drift (heat, fatigue or pace)" : "well coupled"}
        />
      </div>

      {zones && zoneTotal > 0 && (
        <div className="mt-5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Time in HR zones</p>
          <div className="flex h-3 overflow-hidden rounded-full">
            {zones.map((s, i) => (s > 0 ? <div key={i} style={{ width: `${(s / zoneTotal) * 100}%`, background: ZONE_COLORS[i] }} title={`${i === 0 ? "Below Z1" : `Z${i}`}: ${formatDuration(s)}`} /> : null))}
          </div>
          <div className="tabular mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            {zones.map((s, i) => (s > 0 ? <span key={i}>{i === 0 ? "<Z1" : `Z${i}`} {formatDuration(s)}</span> : null))}
          </div>
        </div>
      )}

      {efforts.length > 0 && (
        <div className="mt-5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Best efforts in this run</p>
          <div className="tabular flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {efforts.map((e) => (
              <span key={e.distanceM}>
                <span className="text-muted">{fmtDist(e.distanceM)}</span> {formatDuration(e.timeS)}
              </span>
            ))}
          </div>
        </div>
      )}
      {score.vo2max_from_hr != null && <p className="mt-4 text-xs text-muted">This run&apos;s heart rate vs pace implies a VO2max of about {Math.round(score.vo2max_from_hr)} (one noisy reading; the Progress page combines many).</p>}
    </section>
  );
}
