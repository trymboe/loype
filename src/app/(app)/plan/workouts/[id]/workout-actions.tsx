"use client";

import { useActionState, useState } from "react";
import { editWorkoutAction, type EditState } from "../../actions";

const btn = "btn btn-secondary btn-sm";

export function WorkoutActions({ id, date, today, locked, status, type }: { id: string; date: string; today: string; locked: boolean; status: string; type: string }) {
  const [state, action, pending] = useActionState<EditState, FormData>(editWorkoutAction, {});
  const [moveTo, setMoveTo] = useState(date);
  const Op = ({ op, children }: { op: string; children: React.ReactNode }) => (
    <button name="op" value={op} disabled={pending} className={btn}>
      {children}
    </button>
  );
  return (
    <section className="card rise space-y-4 p-5">
      <h2 className="section-title">Change this workout</h2>
      <form action={action} className="space-y-2">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="op" value="move" />
        {state.issues && state.issuesFor === moveTo && <input type="hidden" name="confirm" value="1" />}
        <div className="flex gap-2">
          <input type="date" name="date" min={today} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="input min-w-0 flex-1" />
          <button disabled={pending || moveTo === date} className="btn btn-primary min-h-12 shrink-0">
            {state.issues && state.issuesFor === moveTo ? "Move anyway" : "Move"}
          </button>
        </div>
        {state.issues && state.issuesFor === moveTo && (
          <ul className="space-y-1">
            {state.issues.map((m, i) => (
              <li key={i} className="rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
                {m}
              </li>
            ))}
          </ul>
        )}
      </form>
      <form action={action} className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={id} />
        {status === "skipped" ? <Op op="unskip">Restore</Op> : <Op op="skip">Skip</Op>}
        {type !== "easy" && type !== "rest" && type !== "race" && <Op op="easy">Make it easy</Op>}
        {type !== "rest" && type !== "race" && <Op op="rest">Make it rest</Op>}
        <Op op={locked ? "unlock" : "lock"}>{locked ? "Unlock" : "Lock"}</Op>
      </form>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-good">Saved.</p>}
    </section>
  );
}
