import { decideProposalAction, undoProposalAction } from "@/app/(app)/plan/actions";
import { formatDay } from "@/lib/dates";
import type { Change } from "@/lib/planning/adapt";

export interface ProposalRow {
  id: string;
  rule: string;
  title: string;
  explanation: string;
  evidence: string[];
  changes: Change[];
  status: string;
  decided_at: string | null;
}

export function ProposalCard({ p }: { p: ProposalRow }) {
  const pending = p.status === "pending";
  return (
    <section className={pending ? "card rise border-accent/60 p-5" : "card rise p-5"}>
      <div className="label">{pending ? "Suggested change" : "Applied change"}</div>
      <p className="mt-1 font-semibold">{p.title}</p>
      <p className="mt-1 text-sm text-muted">{p.explanation}</p>
      {p.evidence.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
          {p.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted">
          {p.changes.length} workout{p.changes.length === 1 ? "" : "s"} affected
        </summary>
        <ul className="mt-2 space-y-1">
          {p.changes.map((c) => (
            <li key={c.workoutId} className="text-xs">
              <span className="text-muted">{formatDay(c.date)}:</span> {c.before.title}
              {c.before.title !== c.after.title ? <> → <span className="font-semibold">{c.after.title}</span></> : <span className="text-muted"> (new targets)</span>}
            </li>
          ))}
        </ul>
      </details>
      <div className="mt-4 flex gap-2">
        {pending ? (
          <>
            <form action={decideProposalAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="decision" value="accept" />
              <button className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg">Accept</button>
            </form>
            <form action={decideProposalAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="decision" value="reject" />
              <button className="rounded-xl bg-surface-2 px-4 py-2 text-sm font-semibold">Keep my plan</button>
            </form>
          </>
        ) : (
          <form action={undoProposalAction}>
            <input type="hidden" name="id" value={p.id} />
            <button className="rounded-xl bg-surface-2 px-4 py-2 text-sm font-semibold">Undo</button>
          </form>
        )}
      </div>
    </section>
  );
}
