import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import { PageHeader } from "./ui";

/** Honest placeholder for sections that are planned but not built. No fake data. */
export function NotYet({ title, what, needs }: { title: string; what: string; needs: string[] }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card rise p-6">
        <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Clock size={20} />
        </div>
        <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Coming soon</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{what}</p>
        <p className="label mt-6">What it will build on</p>
        <ul className="mt-2.5 space-y-2 text-sm text-fg-2">
          {needs.map((n) => (
            <li key={n} className="flex gap-2.5">
              <span className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-subtle" />
              {n}
            </li>
          ))}
        </ul>
        <Link href="/activities" className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-accent">
          See your imported runs <ArrowRight size={15} />
        </Link>
      </div>
    </>
  );
}
