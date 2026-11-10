import { decideProposalAction, undoProposalAction } from "@/app/(app)/plan/actions";
import { formatDay } from "@/lib/dates";
import type { Change } from "@/lib/planning/adapt";
import { SubmitButton } from "@/components/feedback/submit-button";

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
      <p className={pending ? "eyebrow text-accent" : "eyebrow"}>{pending ? "Suggested change" : p.status === "rejected" ? "Declined change" : "Applied change"}</p>
      <p className="mt-1 text-[1.0625rem] font-semibold tracking-[-0.01em]">{p.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">{p.explanation}</p>
      {p.evidence.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-surface-2 p-3 text-xs leading-snug text-muted">
          {p.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {p.status === "rejected" ? (
        <form className="mt-4">
          <input type="hidden" name="id" value={p.id} />
          <p className="mb-2 text-xs text-muted">You kept your plan{p.decided_at ? ` on ${formatDay(p.decided_at.slice(0, 10))}` : ""}. Changed your mind?</p>
          <SubmitButton formAction={decideProposalAction.bind(null, "accept")} className="btn btn-primary btn-sm">
            Apply it after all
          </SubmitButton>
        </form>
      ) : pending ? (
        <>
          <form className="mt-3">
            <input type="hidden" name="id" value={p.id} />
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-accent">
                {p.changes.length} workout{p.changes.length === 1 ? "" : "s"} affected{p.changes.length > 1 ? ": choose which to change" : ""}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {p.changes.map((c) => (
                  <li key={c.workoutId} className="text-xs">
                    <label className="flex items-start gap-2">
                      {p.changes.length > 1 && <input type="checkbox" name="only" value={c.workoutId} defaultChecked className="mt-0.5" />}
                      <span>
                        <span className="text-muted">{formatDay(c.date)}:</span> {c.before.title}
                        {c.toDate ? (
                          <> → moved to <span className="font-semibold">{formatDay(c.toDate)}</span></>
                        ) : c.before.title !== c.after.title ? (
                          <> → <span className="font-semibold">{c.after.title}</span></>
                        ) : (
                          <span className="text-muted"> (new targets)</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {p.changes.length > 1 && (
                <SubmitButton formAction={decideProposalAction.bind(null, "modify")} className="btn btn-secondary btn-sm mt-2">
                  Accept only the ticked ones
                </SubmitButton>
              )}
            </details>
            <div className="mt-4 flex gap-2">
              <SubmitButton formAction={decideProposalAction.bind(null, "accept")} className="btn btn-primary btn-sm">
                Accept{p.changes.length > 1 ? " all" : ""}
              </SubmitButton>
              <SubmitButton formAction={decideProposalAction.bind(null, "reject")} className="btn btn-secondary btn-sm">
                Keep my plan
              </SubmitButton>
            </div>
          </form>
        </>
      ) : (
        <>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-accent">
              {p.changes.length} workout{p.changes.length === 1 ? "" : "s"} changed
            </summary>
            <ul className="mt-2 space-y-1">
              {p.changes.map((c) => (
                <li key={c.workoutId} className="text-xs">
                  <span className="text-muted">{formatDay(c.date)}:</span> {c.before.title}
                  {c.toDate ? (
                          <> → moved to <span className="font-semibold">{formatDay(c.toDate)}</span></>
                        ) : c.before.title !== c.after.title ? (
                          <> → <span className="font-semibold">{c.after.title}</span></>
                        ) : (
                          <span className="text-muted"> (new targets)</span>
                        )}
                </li>
              ))}
            </ul>
          </details>
          <form action={undoProposalAction} className="mt-4">
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton className="btn btn-secondary btn-sm">Undo</SubmitButton>
          </form>
        </>
      )}
    </section>
  );
}
