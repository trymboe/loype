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
    <section className={pending ? "card rise relative overflow-hidden p-5" : "card rise p-5"}>
      {pending && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />}
      <p className={pending ? "eyebrow text-accent" : "eyebrow"}>{pending ? "Suggested change" : "Applied change"}</p>
      <p className="mt-1 text-[1.0625rem] font-semibold tracking-[-0.01em]">{p.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">{p.explanation}</p>
      {p.evidence.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-surface-2 p-3 text-xs leading-snug text-muted">
          {p.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-accent">
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
              <button className="btn btn-primary btn-sm">Accept</button>
            </form>
            <form action={decideProposalAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="decision" value="reject" />
              <button className="btn btn-secondary btn-sm">Keep my plan</button>
            </form>
          </>
        ) : (
          <form action={undoProposalAction}>
            <input type="hidden" name="id" value={p.id} />
            <button className="btn btn-secondary btn-sm">Undo</button>
          </form>
        )}
      </div>
    </section>
  );
}
