import Link from "next/link";
import { PageHeader } from "./ui";

/** Honest placeholder for sections that are planned but not built. No fake data. */
export function NotYet({ title, what, needs }: { title: string; what: string; needs: string[] }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card rise p-6">
        <p className="font-semibold">Not built yet</p>
        <p className="mt-1 text-sm text-muted">{what}</p>
        <p className="label mt-5">What it will build on</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          {needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <Link href="/activities" className="mt-5 inline-block text-sm font-semibold text-accent">
          See your imported runs →
        </Link>
      </div>
    </>
  );
}
