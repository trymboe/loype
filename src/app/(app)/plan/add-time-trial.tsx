"use client";

import { useActionState } from "react";
import { Timer } from "lucide-react";
import { addTimeTrialAction, type TimeTrialState } from "./actions";

export function AddTimeTrial({ planId }: { planId: string }) {
  const [state, action, pending] = useActionState<TimeTrialState, FormData>(addTimeTrialAction, {});
  return (
    <form action={action} className="ml-auto flex flex-col items-end gap-1">
      <input type="hidden" name="planId" value={planId} />
      <button disabled={pending} className="chip">
        <Timer size={14} /> {pending ? "Adding…" : "Add time trial"}
      </button>
      {state.error && <p className="max-w-xs text-right text-xs leading-snug text-danger">{state.error}</p>}
    </form>
  );
}
