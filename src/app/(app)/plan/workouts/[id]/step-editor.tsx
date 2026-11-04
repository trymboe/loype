"use client";

import { useActionState, useMemo, useState } from "react";
import { Minus, Plus, Repeat, Trash2 } from "lucide-react";
import clsx from "clsx";
import { editWorkoutAction, type EditState } from "../../actions";
import type { EditableSimple, EditableStep } from "@/lib/planning/edit-steps";
import type { Zone } from "@/lib/planning/types";

const ZONES: { key: Zone; label: string }[] = [
  { key: "recovery", label: "Recovery" },
  { key: "easy", label: "Easy" },
  { key: "steady", label: "Steady" },
  { key: "marathon", label: "Marathon" },
  { key: "threshold", label: "Threshold" },
  { key: "interval", label: "Interval" },
  { key: "repetition", label: "Repetition" },
  { key: "race", label: "Race pace" },
  { key: "hill", label: "Hill" },
];
const KINDS: { key: EditableSimple["kind"]; label: string }[] = [
  { key: "warmup", label: "Warm-up" },
  { key: "run", label: "Run" },
  { key: "recover", label: "Recover" },
  { key: "cooldown", label: "Cool-down" },
];

/** "4:30" → 270, "45" → 2700 when minutes, "1:05:00" → 3900 */
export function parseClock(v: string, bareIsMinutes = true): number | null {
  const t = v.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * (bareIsMinutes ? 60 : 1));
  const parts = t.split(":").map((x) => Number(x));
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

const input = "input h-10 min-h-0 px-2.5 py-1 text-sm";

function StepRow({ s, onChange, onRemove }: { s: EditableSimple; onChange: (s: EditableSimple) => void; onRemove: () => void }) {
  const byDistance = s.distanceM != null;
  const ownPace = s.paceFast != null;
  const [amount, setAmount] = useState(byDistance ? String((s.distanceM ?? 0) / 1000) : clock(s.durationS ?? 0));
  const [pace, setPace] = useState(ownPace ? [clock(s.paceFast!), clock(s.paceSlow!)] : ["", ""]);
  const setAmountValue = (v: string, dist = byDistance) => {
    setAmount(v);
    if (dist) {
      const km = parseFloat(v.replace(",", "."));
      onChange({ ...s, distanceM: Number.isFinite(km) ? Math.round(km * 1000) : undefined, durationS: undefined });
    } else onChange({ ...s, durationS: parseClock(v) ?? undefined, distanceM: undefined });
  };
  const setPaceValue = (i: 0 | 1, v: string) => {
    const next = [...pace] as [string, string];
    next[i] = v;
    setPace(next);
    const a = parseClock(next[0], false);
    const b = parseClock(next[1] || next[0], false);
    onChange({ ...s, paceFast: a ?? undefined, paceSlow: a != null ? (b ?? a) : undefined });
  };
  return (
    <div className="space-y-2 rounded-xl bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <select value={s.kind} onChange={(e) => onChange({ ...s, kind: e.target.value as EditableSimple["kind"] })} className={clsx(input, "w-28")} aria-label="Step type">
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        <select value={s.zone} onChange={(e) => onChange({ ...s, zone: e.target.value as Zone })} className={clsx(input, "min-w-0 flex-1")} aria-label="Intensity">
          {ZONES.map((z) => (
            <option key={z.key} value={z.key}>
              {z.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} className="btn btn-ghost btn-sm shrink-0 px-2" aria-label="Remove step">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input value={amount} onChange={(e) => setAmountValue(e.target.value)} inputMode="decimal" className={clsx(input, "w-24")} aria-label={byDistance ? "Distance in km" : "Time (mm:ss or minutes)"} />
        <div className="flex overflow-hidden rounded-lg text-xs ring-1 ring-[var(--hairline)]">
          {(["time", "km"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAmountValue(m === "km" ? "1" : "5:00", m === "km")}
              className={clsx("px-2.5 py-1.5", (m === "km") === byDistance ? "bg-accent text-accent-fg" : "text-muted")}
            >
              {m === "time" ? "time" : "km"}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={ownPace}
            onChange={(e) => {
              if (e.target.checked) {
                setPace(["5:00", "5:10"]);
                onChange({ ...s, paceFast: 300, paceSlow: 310 });
              } else {
                setPace(["", ""]);
                onChange({ ...s, paceFast: undefined, paceSlow: undefined });
              }
            }}
          />
          own pace
        </label>
      </div>
      {ownPace && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <input value={pace[0]} onChange={(e) => setPaceValue(0, e.target.value)} className={clsx(input, "w-20")} aria-label="Fastest pace per km" />
          to
          <input value={pace[1]} onChange={(e) => setPaceValue(1, e.target.value)} className={clsx(input, "w-20")} aria-label="Slowest pace per km" />
          /km
        </div>
      )}
    </div>
  );
}

const blank = (): EditableSimple => ({ kind: "run", durationS: 300, zone: "easy" });

export function StepEditor({ id, initial }: { id: string; initial: EditableStep[] }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<EditableStep[]>(initial);
  const [key, setKey] = useState(0); // remount rows after structural changes
  const [state, action, pending] = useActionState<EditState, FormData>(editWorkoutAction, {});
  const payload = useMemo(() => JSON.stringify(steps), [steps]);
  const confirming = state.issues && state.issuesFor === payload;

  const set = (i: number, s: EditableStep) => setSteps((all) => all.map((x, k) => (k === i ? s : x)));
  const remove = (i: number) => {
    setSteps((all) => all.filter((_, k) => k !== i));
    setKey((k) => k + 1);
  };

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary btn-sm">
        Edit steps and paces
      </button>
    );

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value="steps" />
      <input type="hidden" name="steps" value={payload} />
      {confirming && <input type="hidden" name="confirm" value="1" />}
      <div key={key} className="space-y-2">
        {steps.map((s, i) =>
          s.kind === "repeat" ? (
            <div key={i} className="space-y-2 rounded-2xl p-2.5 ring-1 ring-[var(--hairline)] ring-inset">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Repeat size={15} className="text-accent" />
                <button type="button" className="btn btn-ghost btn-sm px-2" aria-label="One fewer" onClick={() => set(i, { ...s, count: Math.max(1, s.count - 1) })}>
                  <Minus size={14} />
                </button>
                <span className="tabular w-8 text-center">{s.count}×</span>
                <button type="button" className="btn btn-ghost btn-sm px-2" aria-label="One more" onClick={() => set(i, { ...s, count: Math.min(40, s.count + 1) })}>
                  <Plus size={14} />
                </button>
                <button type="button" onClick={() => remove(i)} className="btn btn-ghost btn-sm ml-auto px-2" aria-label="Remove repeat">
                  <Trash2 size={16} />
                </button>
              </div>
              {s.steps.map((x, k) => (
                <StepRow
                  key={k}
                  s={x}
                  onChange={(nx) => set(i, { ...s, steps: s.steps.map((y, j) => (j === k ? nx : y)) })}
                  onRemove={() => {
                    if (s.steps.length === 1) remove(i);
                    else {
                      set(i, { ...s, steps: s.steps.filter((_, j) => j !== k) });
                      setKey((n) => n + 1);
                    }
                  }}
                />
              ))}
              <button type="button" onClick={() => set(i, { ...s, steps: [...s.steps, { kind: "recover", durationS: 90, zone: "recovery" }] })} className="btn btn-ghost btn-sm">
                <Plus size={14} /> Step in repeat
              </button>
            </div>
          ) : (
            <StepRow key={i} s={s} onChange={(nx) => set(i, nx)} onRemove={() => remove(i)} />
          ),
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setSteps((a) => [...a, blank()])} className="btn btn-ghost btn-sm">
          <Plus size={14} /> Step
        </button>
        <button
          type="button"
          onClick={() => setSteps((a) => [...a, { kind: "repeat", count: 4, steps: [{ kind: "run", durationS: 180, zone: "interval" }, { kind: "recover", durationS: 120, zone: "recovery" }] }])}
          className="btn btn-ghost btn-sm"
        >
          <Repeat size={14} /> Repeat
        </button>
      </div>
      {confirming && (
        <ul className="space-y-1">
          {state.issues!.map((m, i) => (
            <li key={i} className="rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
              {m}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button disabled={pending || steps.length === 0} className="btn btn-primary min-h-11 flex-1">
          {pending ? "Saving…" : confirming ? "Save anyway" : "Save steps"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSteps(initial);
            setKey((k) => k + 1);
            setOpen(false);
          }}
          className="btn btn-secondary min-h-11"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Intensities use the paces and heart rates from your current fitness. Tick “own pace” to set your own. Løype checks the result against the plan’s safety rules before saving.
      </p>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-good">Saved.</p>}
    </form>
  );
}
