"use client";

import { useActionState } from "react";
import { Timer } from "lucide-react";
import { addTimeTrialAction, type TimeTrialState } from "./actions";

/** Adds a time trial to the plan, at 3 or 5 km. */
export function AddTimeTrial({ planId }: { planId: string }) {
  const [state, action, pending] = useActionState<TimeTrialState, FormData>(addTimeTrialAction, {});
  return (
    <form action={action} className="ml-auto flex flex-col items-end gap-1">
      <input type="hidden" name="planId" value={planId} />
      <div className="flex items-center gap-2">
        <select name="km" defaultValue="5" aria-label="Distance" className="chip">
          <option value="3">3 km</option>
          <option value="5">5 km</option>
        </select>
        <button disabled={pending} className="chip">
          <Timer size={14} /> {pending ? "Adding…" : "Add time trial"}
        </button>
      </div>
      {state.error && <p className="max-w-xs text-right text-xs leading-snug text-danger">{state.error}</p>}
    </form>
  );
}

/** Switches an upcoming time trial between 3 and 5 km. */
export function TimeTrialDistance({ workoutId, km }: { workoutId: string; km: number }) {
  const [state, action, pending] = useActionState<TimeTrialState, FormData>(addTimeTrialAction, {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="workoutId" value={workoutId} />
      <div className="flex gap-2">
        {[3, 5].map((d) => (
          <button key={d} name="km" value={String(d)} disabled={pending || d === km} aria-pressed={d === km} className="chip">
            {d} km
          </button>
        ))}
      </div>
      {state.error && <p className="text-xs leading-snug text-danger">{state.error}</p>}
    </form>
  );
}
