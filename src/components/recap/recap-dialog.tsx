"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { dismissWeeklyRecap } from "@/app/(app)/recap-actions";

/** Opens the weekly recap over Today on the first visit of a new week; closing marks it seen. */
export function RecapDialog({ weekStart, title, children }: { weekStart: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => {
    setOpen(false);
    void dismissWeeklyRecap(weekStart).catch(() => {});
  }, [weekStart]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", key);
    };
  }, [open, close]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="reveal-in fixed inset-0 z-[60] overflow-y-auto bg-[var(--bg)]"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto w-full max-w-2xl px-4 pt-4 pb-8 md:pt-10">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-[2rem] leading-[1.1] font-bold tracking-[-0.03em]">{title}</p>
          <button onClick={close} aria-label="Close" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted hover:text-[var(--fg)]">
            <X size={19} />
          </button>
        </div>
        {children}
        <button onClick={close} className="btn btn-primary mt-5 w-full">
          On to this week
        </button>
      </div>
    </div>
  );
}
