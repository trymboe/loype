import type { Step } from "@/lib/planning/types";

const KIND: Record<string, string> = { warmup: "Warm-up", cooldown: "Cool-down", run: "Run", recover: "Recover" };

export const fmtStepTime = (s: number) => (s >= 120 ? `${Math.round(s / 60)} min` : s % 60 === 0 && s >= 60 ? `${s / 60} min` : `${Math.round(s)} s`);

export function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return <p className="text-sm text-muted">Rest day.</p>;
  return (
    <ol className="space-y-2">
      {steps.map((s, i) =>
        s.kind === "repeat" ? (
          <li key={i} className="rounded-2xl p-3 ring-1 ring-[var(--hairline)] ring-inset">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <span className="tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent/12 px-1.5 text-xs text-accent">{s.count}×</span>
              Repeat
            </div>
            <Steps steps={s.steps} />
          </li>
        ) : (
          <li key={i} className="flex gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5">
            <div className="w-20 shrink-0 text-xs text-muted">
              {KIND[s.kind]}
              <div className="tabular mt-0.5 text-[0.9375rem] font-semibold text-fg">{s.distanceM ? `${(s.distanceM / 1000).toFixed(1)} km` : fmtStepTime(s.durationS ?? 0)}</div>
            </div>
            <div className="min-w-0 self-center text-sm leading-snug">
              <div>{s.target.label}</div>
              {s.note && <div className="mt-0.5 text-xs text-muted">{s.note}</div>}
            </div>
          </li>
        ),
      )}
    </ol>
  );
}
