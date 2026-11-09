import Link from "@/components/link";
import { Badge, Card, Stat } from "@/components/ui";
import { EfficiencyChart, FitnessTrendChart, LoadChart, type TrendPoint } from "@/components/fitness-charts";
import { fmtDist } from "@/lib/analytics/fitness/estimate";
import type { CompactOutput } from "@/lib/fitness/service";
import { formatDay } from "@/lib/dates";
import { formatDuration, formatPace } from "@/lib/units";

const CONF_TONE = { high: "good", medium: "warn", low: "muted" } as const;
const ZONE_DOT: Record<number, string> = { 1: "var(--elev)", 2: "var(--easy)", 3: "var(--good)", 4: "var(--tempo)", 5: "var(--intervals)" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Provenance({ confidence, children }: { confidence?: "high" | "medium" | "low" | null; children?: React.ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted">
      <Badge tone="muted">Estimated</Badge>
      {confidence && <Badge tone={CONF_TONE[confidence]}>{cap(confidence)} confidence</Badge>}
      {children}
    </span>
  );
}

export function FitnessSection({ out, history }: { out: CompactOutput; history: TrendPoint[]; computedAt?: string }) {
  const e = out.estimate;
  const p = out.physiology;
  const last = out.load[out.load.length - 1];
  const efPoints = out.efficiency.points.map((pt) => ({ date: pt.date, ef: pt.ef, t: Date.parse(pt.date) }));
  if (out.efficiency.changePer30dPct != null && efPoints.length) {
    const sorted = [...efPoints].sort((a, b) => a.ef - b.ef);
    const med = sorted[Math.floor(sorted.length / 2)].ef;
    const tMid = efPoints[Math.floor(efPoints.length / 2)].t;
    const perDay = ((out.efficiency.changePer30dPct / 100) * med) / 30;
    for (const pt of efPoints) Object.assign(pt, { trend: med + perDay * ((pt.t - tMid) / 86400_000) });
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-title">Fitness estimate</h2>
          {!e.withheld && <Provenance confidence={e.confidence} />}
        </div>
        {e.withheld ? (
          <p className="mt-3 font-semibold">Not enough data yet</p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 items-end gap-x-5 gap-y-6 sm:grid-cols-3">
              <Stat size="xl" label="VO2max equivalent" value={e.vdot.toFixed(1)} hint={`${e.lower.toFixed(1)}–${e.upper.toFixed(1)}`} />
              {out.threshold && (
                <Stat
                  label="Threshold pace"
                  value={formatPace(out.threshold.paceSPerKm)}
                  unit="/km"
                  hint={`${formatPace(out.threshold.paceRange[0])}–${formatPace(out.threshold.paceRange[1])}`}
                />
              )}
              {out.threshold?.hr && <Stat label="Threshold HR" value={out.threshold.hr} unit="bpm" />}
            </div>
            <details className="mt-3 text-xs">
              <summary className="inline-flex cursor-pointer items-center gap-1 font-medium text-accent">Show evidence ({e.evidence.length})</summary>
              <ul className="mt-2 space-y-1">
                {e.evidence.map((x) => (
                  <li key={x.activityId + x.kind} className="flex justify-between gap-3">
                    <Link href={`/activities/${x.activityId}`} className="underline underline-offset-2">
                      {formatDay(x.date)} · {x.detail}
                    </Link>
                    <span className="tabular shrink-0 text-muted">
                      {x.kind === "floor" ? "floor " : ""}
                      {x.value.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </Card>

      {out.predictions && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="section-title">Race predictions</h2>
            <Provenance />
          </div>
          <table className="tabular mt-3 w-full text-sm">
            <tbody>
              {out.predictions.map((r) => (
                <tr key={r.key} className="border-t border-[var(--hairline)] first:border-0">
                  <td className="py-3 font-medium">{r.label}</td>
                  <td className="display py-3 text-right text-lg">{formatDuration(r.timeS)}</td>
                  <td className="py-3 pl-4 text-right text-xs leading-snug text-muted">
                    {formatDuration(r.fastS)}–{formatDuration(r.slowS)}
                    <br />
                    {cap(r.confidence)} confidence
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {history.some((h) => h.value != null) && (
        <Card>
          <h2 className="section-title mb-4">Fitness trend</h2>
          <FitnessTrendChart points={history} />
        </Card>
      )}

      <Card>
        <h2 className="section-title">Zones</h2>
        <div className="mt-3 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="label mb-2">Heart rate</p>
            {out.hrZones ? (
              <table className="tabular w-full text-sm">
                <tbody>
                  {out.hrZones.map((z) => (
                    <tr key={z.zone} className="border-t border-[var(--hairline)] first:border-0">
                      <td className="w-10 py-2"><span className="inline-block size-2 rounded-full" style={{ background: ZONE_DOT[z.zone] }} /> <span className="text-muted">{z.zone}</span></td>
                      <td className="py-2">{z.label}</td>
                      <td className="py-2 text-right font-medium">
                        {z.minBpm}–{z.maxBpm}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">Needs max and resting HR.</p>
            )}
            <p className="mt-2 text-[0.6875rem] text-muted">
              Max {p.maxHr?.value ?? "–"} · resting {p.restHr?.value ?? "–"} · <Link href="/more/profile" className="underline">Change</Link>
            </p>
          </div>
          <div>
            <p className="label mb-2">Training paces</p>
            {out.paceZones ? (
              <table className="tabular w-full text-sm">
                <tbody>
                  {out.paceZones.map((z) => (
                    <tr key={z.key} className="border-t border-[var(--hairline)] first:border-0" title={z.purpose}>
                      <td className="py-2">{z.label}</td>
                      <td className="py-1.5 text-right">
                        {formatPace(z.fastSPerKm)}–{formatPace(z.slowSPerKm)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">No fitness estimate yet.</p>
            )}
          </div>
        </div>
      </Card>

      {last && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="section-title">Training load</h2>
            <Badge>Calculated · TRIMP</Badge>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-5">
            <Stat label="Fitness (42 d)" value={last.ctl.toFixed(0)} />
            <Stat label="Fatigue (7 d)" value={last.atl.toFixed(0)} />
            <Stat label="Form" value={`${last.tsb > 0 ? "+" : ""}${last.tsb.toFixed(0)}`} hint={out.rampRate != null ? `fitness ${out.rampRate >= 0 ? "+" : ""}${out.rampRate}/wk` : undefined} />
          </div>
          <div className="mt-4">
            <LoadChart days={out.load} />
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-title">Aerobic efficiency</h2>
          <Badge>Calculated</Badge>
        </div>
        {efPoints.length >= 2 ? (
          <>
            <p className="mt-2 text-sm">
              {out.efficiency.changePer30dPct == null ? (
                <span className="text-muted">No trend yet.</span>
              ) : (
                <>
                  <span className={out.efficiency.changePer30dPct >= 0 ? "font-semibold text-good" : "font-semibold text-warn"}>
                    {out.efficiency.changePer30dPct >= 0 ? "+" : ""}
                    {out.efficiency.changePer30dPct.toFixed(1)} % per month
                  </span>{" "}
                  <span className="text-muted">over {efPoints.length} runs</span>
                </>
              )}
            </p>
            <div className="mt-3">
              <EfficiencyChart points={efPoints} />
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">Not enough steady runs yet.</p>
        )}
      </Card>

      {out.bestEfforts.allTime.length > 0 && (
        <Card>
          <h2 className="section-title">Best efforts</h2>
          <table className="tabular mt-3 w-full text-sm">
            <thead className="text-left text-[0.6875rem] text-muted">
              <tr>
                <th className="py-1 font-medium">Distance</th>
                <th className="py-1 text-right font-medium">Last 90 days</th>
                <th className="py-1 text-right font-medium">All imported</th>
              </tr>
            </thead>
            <tbody>
              {out.bestEfforts.allTime.map((b) => {
                const r = out.bestEfforts.last90.find((x) => x.distanceM === b.distanceM);
                return (
                  <tr key={b.distanceM} className="border-t border-[var(--hairline)]">
                    <td className="py-2">{fmtDist(b.distanceM)}</td>
                    <td className="py-2 text-right">
                      {r ? (
                        <Link href={`/activities/${r.activityId}`} className="underline-offset-2 hover:underline">
                          {formatDuration(r.timeS)}
                        </Link>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Link href={`/activities/${b.activityId}`} className="underline-offset-2 hover:underline">
                        {formatDuration(b.timeS)}
                      </Link>
                      <span className="block text-[0.6875rem] text-muted">{formatDay(b.date, { day: "numeric", month: "short", year: "2-digit" })}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
