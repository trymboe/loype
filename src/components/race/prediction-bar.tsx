import { fmtTime } from "@/lib/analytics/fitness/estimate";
import type { ProjectionInput, RacePredictionNow } from "@/lib/race/status";

/** Time scale (slower on the left, faster on the right) with the likely range, the target and the plan projection. */
export function PredictionBar({ prediction, target, projection }: { prediction: RacePredictionNow; target: number | null; projection: ProjectionInput | null }) {
  const times = [prediction.fastS, prediction.slowS, prediction.timeS, ...(target ? [target] : []), ...(projection ? [projection.projectedS, projection.fastS] : [])];
  const span = Math.max(...times) - Math.min(...times);
  const pad = Math.max(span * 0.12, 20);
  const slow = Math.max(...times) + pad;
  const fast = Math.min(...times) - pad;
  const x = (t: number) => `${((slow - t) / (slow - fast)) * 100}%`;
  return (
    <div className="mt-6" aria-hidden>
      <div className="relative h-14">
        <div className="absolute inset-x-0 top-7 h-1.5 rounded-full bg-surface-2" />
        <div className="absolute top-7 h-1.5 rounded-full bg-accent/30" style={{ left: x(prediction.slowS), right: `calc(100% - ${x(prediction.fastS)})` }} />
        {projection && (
          <Marker at={x(projection.projectedS)} color="var(--good)" label={`Plan ${fmtTime(projection.projectedS)}`} below />
        )}
        <Marker at={x(prediction.timeS)} color="var(--accent)" label={`Now ${fmtTime(prediction.timeS)}`} below={false} />
        {target && <Marker at={x(target)} color="var(--fg)" label={`Target ${fmtTime(target)}`} below line />}
      </div>
      <div className="mt-5 flex justify-between text-[0.625rem] text-subtle">
        <span>Slower</span>
        <span>Faster</span>
      </div>
    </div>
  );
}

function Marker({ at, color, label, below, line }: { at: string; color: string; label: string; below: boolean; line?: boolean }) {
  return (
    <div className="absolute top-0 h-full" style={{ left: at }}>
      {line ? (
        <span className="absolute top-5 h-5 w-[2px] -translate-x-1/2 rounded-full" style={{ background: color }} />
      ) : (
        <span className="absolute top-[1.5625rem] size-3.5 -translate-x-1/2 rounded-full border-2 border-[var(--surface)]" style={{ background: color }} />
      )}
      <span
        className="tabular absolute -translate-x-1/2 text-[0.6875rem] font-semibold whitespace-nowrap"
        style={{ color, top: below ? "2.75rem" : "0.125rem" }}
      >
        {label}
      </span>
    </div>
  );
}
