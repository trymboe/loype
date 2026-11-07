"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { linkWorkoutAction } from "@/app/(app)/routes/actions";

/** Links a suggested route to the planned workout. */
export function UseRouteButton({ routeId, workoutId }: { routeId: string; workoutId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm shrink-0"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await linkWorkoutAction(routeId, workoutId, true);
        })
      }
    >
      {pending && <Loader2 size={14} className="animate-spin" />} Use
    </button>
  );
}
