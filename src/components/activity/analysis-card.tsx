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
const ZONE_COLORS = ["var(--surface-3)", "var(--elev)", "var(--easy)", "var(--good)", "var(--tempo)", "var(--intervals)"];

export function AnalysisCard({ activityId, score, features, override }: { activityId: string; score: any | null; features: any | null; override: string | null }) {
  if (!score) {
    return (
      <section className="card mb-3 flex items-baseline justify-between gap-3 p-5">
        <h2 className="section-title">Analysis</h2>
        <span className="text-sm text-muted">Not analysed yet</span>
      </section>
    );
  }
  const cls = score.classification as RunClass;
  const zones: number[] | null = score.zone_seconds;
  const zoneTotal = zones ? zones.reduce((a, b) => a + b, 0) : 0;
  const efforts: any[] = (features?.bestEfforts ?? []).filter((e: any) => e.distanceM >= 1000);

  return (
    <section className="card rise mb-3 p-5">
      <h2 className="section-title">Analysis</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold"
          style={{ color: CLASS_COLOR[cls] ?? "var(--muted)", background: `color-mix(in srgb, ${CLASS_COLOR[cls] ?? "var(--muted)"} 15%, transparent)` }}
        >
          <span className="size-1.5 rounded-full" style={{ background: CLASS_COLOR[cls] ?? "var(--muted)" }} />
          {RUN_CLASS_LABEL[cls]}
        </span>
        <Badge tone="muted">{override ? "Set by you" : `Auto · ${Math.round((score.classification_confidence ?? 0) * 100)} % sure`}</Badge>
      </div>
      <form action={setClassification} className="mt-3 flex items-center gap-2">
        <input type="hidden" name="activityId" value={activityId} />
        <select name="classification" defaultValue={override ?? ""} className="input input-sm">
          <option value="">Automatic</option>
          {(Object.keys(RUN_CLASS_LABEL) as RunClass[])
            .filter((c) => c !== "unknown")
            .map((c) => (
              <option key={c} value={c}>
                {RUN_CLASS_LABEL[c]}
              </option>
            ))}
        </select>
        <button className="btn btn-secondary btn-sm">Save type</button>
      </form>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-[var(--hairline)] pt-5 sm:grid-cols-4">
        <Stat
          size="md"
          label="Training load"
          value={score.trimp != null ? Math.round(score.trimp) : "–"}
          unit="TRIMP"
          hint={score.trimp_method === "pace_estimate" ? "from pace" : undefined}
        />
        <Stat
          size="md"
          label="Intensity"
          value={score.intensity != null ? `${Math.round(score.intensity * 100)}` : "–"}
          unit="% HRR"
          hint={score.intensity_source === "pace" ? "from pace" : undefined}
        />
        <Stat size="md" label="Efficiency" value={score.ef != null ? score.ef.toFixed(2) : "–"} />
        <Stat
          size="md"
          label="HR drift"
          value={score.decoupling_pct != null ? `${score.decoupling_pct > 0 ? "+" : ""}${score.decoupling_pct.toFixed(1)}` : "–"}
          unit="%"
          hint={score.decoupling_pct != null && score.decoupling_pct > 5 ? "high" : undefined}
        />
      </div>

      {zones && zoneTotal > 0 && (
        <div className="mt-5">
          <p className="label mb-2">Time in heart-rate zones</p>
          <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
            {zones.map((s, i) => (s > 0 ? <div key={i} style={{ width: `${(s / zoneTotal) * 100}%`, background: ZONE_COLORS[i] }} title={`${i === 0 ? "Below Z1" : `Z${i}`}: ${formatDuration(s)}`} /> : null))}
          </div>
          <div className="tabular mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[0.6875rem] text-muted">
            {zones.map((s, i) =>
              s > 0 ? (
                <span key={i} className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full" style={{ background: ZONE_COLORS[i] }} />
                  {i === 0 ? "<Z1" : `Z${i}`} <span className="text-fg-2">{formatDuration(s)}</span>
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}

      {efforts.length > 0 && (
        <div className="mt-5">
          <p className="label mb-2">Best efforts in this run</p>
          <div className="tabular flex flex-wrap gap-1.5 text-[0.8125rem]">
            {efforts.map((e) => (
              <span key={e.distanceM} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1">
                <span className="text-muted">{fmtDist(e.distanceM)}</span> <span className="font-semibold">{formatDuration(e.timeS)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {score.vo2max_from_hr != null && (
        <div className="mt-5 flex items-baseline justify-between">
          <p className="label">VO2max from this run</p>
          <p className="tabular font-semibold">≈ {Math.round(score.vo2max_from_hr)}</p>
        </div>
      )}
    </section>
  );
}
