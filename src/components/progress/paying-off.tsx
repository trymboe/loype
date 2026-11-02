import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { formatDay } from "@/lib/dates";
import type { Payoff } from "@/lib/progress/paying-off";

const ICON = { good: ArrowUpRight, steady: Minus, down: ArrowDownRight };
const TONE = { good: "text-good bg-good/12", steady: "text-muted bg-surface-2", down: "text-warn bg-warn/12" };

/** "Your training is paying off": the last 8 weeks against the 8 before. */
export function PayingOffCard({ payoff }: { payoff: Payoff }) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">Last 8 weeks vs the 8 before</p>
        <Badge>Calculated</Badge>
      </div>
      <h2 className={clsx("mt-1 text-[1.375rem] leading-tight font-bold tracking-[-0.02em]", payoff.state === "paying_off" && "text-good")}>{payoff.headline}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{payoff.summary}</p>
      {payoff.items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {payoff.items.map((i) => {
            const Icon = ICON[i.tone];
            return (
              <li key={i.key} className="flex gap-3">
                <span className={clsx("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", TONE[i.tone])}>
                  <Icon size={15} strokeWidth={2.4} />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.9375rem] leading-snug font-semibold">{i.title}</p>
                  <p className="mt-0.5 text-xs leading-snug text-muted">{i.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {payoff.items.length > 0 && (
        <details className="mt-4 text-xs text-muted">
          <summary className="cursor-pointer font-medium text-accent">How this is calculated</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4 leading-snug">
            {payoff.items.map((i) => (
              <li key={i.key}>{i.basis}</li>
            ))}
            <li>This block runs from {formatDay(payoff.from, { day: "numeric", month: "short" })}. Changes smaller than normal week-to-week noise are shown as steady.</li>
          </ul>
        </details>
      )}
    </Card>
  );
}
