import { decideProposalAction, undoProposalAction } from "@/app/(app)/plan/actions";
import { formatDay } from "@/lib/dates";
import { RULE_DETAIL, type Change, type Rule } from "@/lib/planning/adapt";

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
      {RULE_DETAIL[p.rule as Rule] && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-accent">Explain further</summary>
          <dl className="mt-2 space-y-2 text-xs leading-relaxed">
            {(
              [
                ["What it looks at", RULE_DETAIL[p.rule as Rule].looksAt],
                ["Why it matters", RULE_DETAIL[p.rule as Rule].why],
                ["The evidence", RULE_DETAIL[p.rule as Rule].evidence],
                ["If you keep your plan", RULE_DETAIL[p.rule as Rule].ifKept],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="font-semibold text-fg-2">{k}</dt>
                <dd className="text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {pending ? (
        <>
          <form action={decideProposalAction} className="mt-3">
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
                <button name="decision" value="modify" className="btn btn-secondary btn-sm mt-2">
                  Accept only the ticked ones
                </button>
              )}
            </details>
            <div className="mt-4 flex gap-2">
              <button name="decision" value="accept" className="btn btn-primary btn-sm">
                Accept{p.changes.length > 1 ? " all" : ""}
              </button>
              <button name="decision" value="reject" className="btn btn-secondary btn-sm">
                Keep my plan
              </button>
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
            <button className="btn btn-secondary btn-sm">Undo</button>
          </form>
        </>
      )}
    </section>
  );
}
