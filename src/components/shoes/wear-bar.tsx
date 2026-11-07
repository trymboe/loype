import clsx from "clsx";
import type { WearState } from "@/lib/shoes/mileage";

const FILL: Record<WearState, string> = { ok: "bg-accent", near: "bg-warn", due: "bg-danger" };

export function WearBar({ fraction, state }: { fraction: number; state: WearState }) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className={clsx("h-full rounded-full", FILL[state])} style={{ width: `${Math.max(pct, fraction > 0 ? 2 : 0)}%` }} />
    </div>
  );
}
