"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { editWorkoutAction } from "@/app/(app)/plan/actions";

export interface MonthWorkout {
  id: string;
  date: string;
  type: string;
  title: string;
  duration_s: number;
  status: string;
  locked: boolean;
}

const HARD = new Set(["threshold", "tempo", "vo2max", "repetitions", "hills", "race_pace", "race"]);
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + "T00:00:00Z");
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const monthStart = (s: string) => s.slice(0, 8) + "01";
const shiftMonth = (s: string, n: number) => {
  const d = parse(monthStart(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};

function chipClass(w: MonthWorkout) {
  if (w.status === "completed") return "bg-good/15 text-good";
  if (w.status === "missed") return "bg-danger/12 text-danger";
  if (w.status === "skipped") return "bg-surface-2 text-muted line-through";
  if (w.type === "race") return "bg-intervals text-bg";
  if (HARD.has(w.type)) return "bg-intervals/15 text-intervals";
  if (w.type === "long" || w.type === "progressive_long") return "bg-accent/15 text-accent";
  return "bg-surface-2 text-fg-2";
}

const short = (w: MonthWorkout) => {
  const m = Math.round(w.duration_s / 60);
  const t = w.type === "progressive_long" ? "long" : w.type === "race_pace" ? "race pace" : w.type === "vo2max" ? "VO2" : w.type;
  return w.type === "race" ? "Race" : `${t} ${m}′`;
};

/**
 * Month calendar of the plan. Drag a planned session onto another day to move
 * it (press and hold on touch screens). Moves go through the same checks as
 * moving from the workout page, and are saved in the plan history.
 */
export function PlanMonth({ workouts, today, first, last }: { workouts: MonthWorkout[]; today: string; first: string; last: string }) {
  const router = useRouter();
  const [month, setMonth] = useState(() => monthStart(today < first ? first : today > last ? last : today));
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: string | null } | null>(null);
  const [pendingMove, setPendingMove] = useState<{ id: string; date: string; issues: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; id: string; x: number; y: number; moved: boolean } | null>(null);

  const byDate = useMemo(() => {
    const m = new Map<string, MonthWorkout[]>();
    for (const w of workouts) if (w.type !== "rest") m.set(w.date, [...(m.get(w.date) ?? []), w]);
    return m;
  }, [workouts]);

  const gridStart = (() => {
    const d = parse(month);
    return addDays(month, -((d.getUTCDay() + 6) % 7));
  })();
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const rows = days[35].slice(0, 7) === month.slice(0, 7) ? 6 : 5;
  const label = parse(month).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

  const move = (id: string, date: string, confirm: boolean) =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("id", id);
      fd.set("op", "move");
      fd.set("date", date);
      if (confirm) fd.set("confirm", "1");
      const res = await editWorkoutAction({}, fd);
      if (res.issues?.length) setPendingMove({ id, date, issues: res.issues });
      else if (res.error) setError(res.error);
      else {
        setPendingMove(null);
        router.refresh();
      }
    });

  const dayAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-day]") as HTMLElement | null)?.dataset.day ?? null;

  const onPointerDown = (e: React.PointerEvent, w: MonthWorkout) => {
    if (w.status !== "planned" || w.date < today || busy) return;
    const isTouch = e.pointerType === "touch";
    hold.current = { timer: null, id: w.id, x: e.clientX, y: e.clientY, moved: false };
    const begin = () => setDrag({ id: w.id, x: hold.current!.x, y: hold.current!.y, over: w.date });
    if (isTouch) hold.current.timer = setTimeout(begin, 300);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!isTouch) hold.current.timer = setTimeout(begin, 120);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const h = hold.current;
    if (!h) return;
    h.x = e.clientX;
    h.y = e.clientY;
    if (!drag) {
      // a touch that moves before the hold fires is a scroll, not a drag
      if (e.pointerType === "touch" && h.timer) {
        clearTimeout(h.timer);
        hold.current = null;
      }
      return;
    }
    e.preventDefault();
    h.moved = true;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, over: dayAt(e.clientX, e.clientY) });
  };
  const onPointerUp = (e: React.PointerEvent, w: MonthWorkout) => {
    const h = hold.current;
    if (h?.timer) clearTimeout(h.timer);
    hold.current = null;
    if (!drag) return;
    const target = dayAt(e.clientX, e.clientY);
    setDrag(null);
    e.preventDefault();
    if (target && target !== w.date) {
      if (target < today) setError("You can't move a workout into the past.");
      else move(w.id, target, false);
    }
  };

  const dragged = drag ? workouts.find((w) => w.id === drag.id) : null;

  return (
    <div className="card p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <button type="button" className="btn btn-ghost btn-sm px-2" onClick={() => setMonth((m) => shiftMonth(m, -1))} disabled={month <= monthStart(first)} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <div className="text-[0.9375rem] font-semibold">{label}</div>
        <button type="button" className="btn btn-ghost btn-sm px-2" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= monthStart(last)} aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] text-muted">
        {DOW.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className={clsx("mt-1 grid grid-cols-7 gap-1", drag && "touch-none select-none")}>
        {days.slice(0, rows * 7).map((day) => {
          const inMonth = day.slice(0, 7) === month.slice(0, 7);
          const items = byDate.get(day) ?? [];
          const over = drag?.over === day && day !== dragged?.date;
          return (
            <div
              key={day}
              data-day={day}
              className={clsx(
                "min-h-[4.5rem] rounded-lg p-1 text-left transition-colors",
                inMonth ? "bg-surface-2/50" : "opacity-40",
                day === today && "ring-2 ring-accent ring-inset",
                over && (day < today ? "bg-danger/10" : "bg-accent/15"),
              )}
            >
              <div className={clsx("tabular mb-0.5 text-[0.6875rem]", day === today ? "font-semibold text-accent" : "text-muted")}>{Number(day.slice(8))}</div>
              <div className="space-y-0.5">
                {items.map((w) => {
                  const movable = w.status === "planned" && w.date >= today;
                  return (
                    <Link
                      key={w.id}
                      href={`/plan/workouts/${w.id}`}
                      draggable={false}
                      onClick={(e) => (hold.current?.moved || drag) && e.preventDefault()}
                      onPointerDown={(e) => onPointerDown(e, w)}
                      onPointerMove={onPointerMove}
                      onPointerUp={(e) => onPointerUp(e, w)}
                      onPointerCancel={() => {
                        if (hold.current?.timer) clearTimeout(hold.current.timer);
                        hold.current = null;
                        setDrag(null);
                      }}
                      onContextMenu={(e) => movable && e.preventDefault()}
                      title={`${w.title}${movable ? " · drag to move" : ""}`}
                      className={clsx(
                        "flex items-center gap-0.5 truncate rounded px-1 py-0.5 text-[0.625rem] leading-tight font-medium",
                        chipClass(w),
                        movable && "cursor-grab",
                        drag?.id === w.id && "opacity-40",
                      )}
                    >
                      {movable && <GripVertical size={9} className="hidden shrink-0 opacity-50 sm:block" />}
                      <span className="truncate">{short(w)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {drag && dragged && (
        <div className={clsx("pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold shadow-lg", chipClass(dragged))} style={{ left: drag.x, top: drag.y }}>
          {short(dragged)}
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">Drag a planned session to another day to move it (press and hold on a phone). Tap it to open.</p>
      {busy && <p className="mt-2 text-xs text-muted">Moving…</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {pendingMove && (
        <div className="mt-3 space-y-2 rounded-xl bg-warn/10 p-3">
          <ul className="space-y-1 text-xs leading-snug text-warn">
            {pendingMove.issues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" disabled={busy} className="btn btn-primary btn-sm" onClick={() => move(pendingMove.id, pendingMove.date, true)}>
              Move anyway
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPendingMove(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
