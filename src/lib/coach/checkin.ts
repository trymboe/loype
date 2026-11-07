import "server-only";
import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { addDaysIso } from "../dates";
import { env } from "../env";
import { formatDuration, formatPace } from "../units";
import type { LoadDay } from "../analytics/fitness/load";
import { isDemanding, type Step, type WorkoutType } from "../planning/types";
import { loadRuns, toWorkoutRow } from "./data";
import { runLine, weeklyTotals, workoutLine, type RunRow, type WeekRow, type WorkoutRow } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Coach check-in after a key session: one or two sentences on whether the run
 * hit the session's goal and what it means for the plan. Generated once per
 * run from deterministic inputs and cached in `coach_checkins`; a new RPE or
 * feedback (or a different matched workout) produces a new one.
 */
export const CHECKIN_VERSION = "checkin@1";

export const CHECKIN_PROMPT = `You are the running coach inside Løype, writing a short check-in on one key session the athlete just ran. You see only this athlete's own data, given below.

Write one or two sentences, at most 45 words, in plain text: did the session hit its goal (compare the planned targets with what was measured: pace, heart rate, reps, duration), and what it means for the plan (keep going as planned, a sign of progress, or ease off). Use their numbers, but only the one or two that matter.
If the data shows injury or overreaching risk (RPE well above what the session called for, discomfort or pain reported, heavy or sore legs, large heart-rate drift), say so plainly and suggest the safer option; the athlete decides.
Sound like a real coach texting their athlete: warm, direct, specific. No greeting, no emoji, no exclamation marks, no lists, no markdown. Never invent a metric the data doesn't contain. Don't mention ids or how the data was given to you.`;

/** Long runs, intervals, tempo/threshold, time trials and races, or anything the plan marks as key. */
export function isKeySession(w: { type: string; key?: boolean | null }): boolean {
  return Boolean(w.key) || w.type === "time_trial" || isDemanding(w.type as WorkoutType);
}

export interface CheckinFeedback {
  rpe: number | null;
  legs: string | null;
  discomfort: string | null;
  notes: string | null;
}

export interface CheckinLap {
  index: number;
  distanceM: number | null;
  timerS: number | null;
  avgSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  intensity: string | null;
}

export interface CheckinSplit {
  index: number;
  distanceM: number;
  paceSPerKm: number | null;
  avgHr: number | null;
  partial: boolean;
}

export interface CheckinData {
  run: RunRow;
  workout: WorkoutRow;
  laps: CheckinLap[];
  splits: CheckinSplit[];
  feedback: CheckinFeedback | null;
  /** first and second half of the steady part (activity_features) */
  halves: { movingS: number; distanceM: number; avgHr: number | null }[] | null;
  /** training load going into the run's day */
  load: Pick<LoadDay, "ctl" | "atl" | "tsb"> | null;
  /** weekly totals for the 4 weeks up to and including the run's week */
  weeks: WeekRow[];
}

/** What, besides the check-in version, should produce a new check-in. */
export function checkinHash(workoutId: string, fb: CheckinFeedback | null): string {
  const key = JSON.stringify([CHECKIN_VERSION, workoutId, fb?.rpe ?? null, fb?.legs ?? null, fb?.discomfort?.trim() || null, fb?.notes?.trim() || null]);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Planned work reps: the repeat counts of repeats that contain work (not recovery) steps. */
export function plannedReps(steps: Step[]): number {
  let n = 0;
  for (const s of steps) if (s.kind === "repeat" && s.steps.some((x) => x.kind === "run")) n += s.count;
  return n;
}

const pace = (distanceM: number | null | undefined, s: number | null | undefined) => (distanceM && s ? `${formatPace(s / (distanceM / 1000))}/km` : "–");

/** The deterministic text the check-in is written from. Pure. */
export function buildCheckinInput(d: CheckinData): string {
  const { run, workout: w } = d;
  const L: string[] = [];
  L.push(`Planned session: ${workoutLine(w, true)}`);
  const reps = plannedReps(w.steps);
  const workLaps = d.laps.filter((l) => l.intensity === "active" || l.intensity === "interval").length;
  if (reps) L.push(`Planned work reps: ${reps}.${d.laps.length ? ` Laps recorded as active/interval: ${workLaps} of ${d.laps.length}.` : ""}`);
  const ex = w.execution;
  if (ex) {
    L.push(
      `Execution (calculated): verdict ${ex.verdict}` +
        (ex.workPace != null ? `, work pace ${formatPace(ex.workPace)}/km` : "") +
        (ex.targetPace ? ` vs target ${formatPace(ex.targetPace[0])}–${formatPace(ex.targetPace[1])}/km` : "") +
        (ex.durationRatio != null ? `, ${Math.round(ex.durationRatio * 100)} % of planned time` : "") +
        ".",
    );
    for (const n of ex.notes ?? []) L.push(`  ${n}`);
  }
  L.push(`Run (measured): ${runLine(run)}`);
  if (run.maxHr) L.push(`Max HR ${Math.round(run.maxHr)}.`);
  const h = d.halves;
  if (h?.[0]?.avgHr && h[1]?.avgHr) {
    L.push(`Steady-part halves (calculated): first ${pace(h[0].distanceM, h[0].movingS)} at HR ${Math.round(h[0].avgHr)}, second ${pace(h[1].distanceM, h[1].movingS)} at HR ${Math.round(h[1].avgHr)} (HR drift ${Math.round(h[1].avgHr - h[0].avgHr)} bpm).`);
  }
  if (d.laps.length > 1) {
    L.push("Laps (measured):");
    for (const l of d.laps) {
      const p = l.avgSpeed ? `${formatPace(1000 / l.avgSpeed)}/km` : pace(l.distanceM, l.timerS);
      L.push(`  ${l.index + 1}: ${((l.distanceM ?? 0) / 1000).toFixed(2)} km in ${formatDuration(l.timerS)}, ${p}, HR ${l.avgHr ? Math.round(l.avgHr) : "–"}/${l.maxHr ? Math.round(l.maxHr) : "–"}${l.intensity ? ` (${l.intensity})` : ""}`);
    }
  }
  if (d.splits.length) {
    L.push("Per-km splits (measured):");
    for (const s of d.splits) L.push(`  km ${s.index + 1}${s.partial ? ` (partial ${(s.distanceM / 1000).toFixed(2)} km)` : ""}: ${s.paceSPerKm ? `${formatPace(s.paceSPerKm)}/km` : "–"}, HR ${s.avgHr ? Math.round(s.avgHr) : "–"}`);
  }
  const fb = d.feedback;
  if (fb && (fb.rpe != null || fb.legs || fb.discomfort || fb.notes)) {
    L.push(
      `Athlete's feedback: ${[fb.rpe != null ? `RPE ${fb.rpe}/10` : null, fb.legs ? `legs ${fb.legs}` : null, fb.discomfort ? `discomfort: "${fb.discomfort.slice(0, 300)}"` : null, fb.notes ? `notes: "${fb.notes.slice(0, 300)}"` : null]
        .filter(Boolean)
        .join(", ")}.`,
    );
  } else L.push("Athlete's feedback: none yet.");
  if (d.load) L.push(`Training load going into the day (calculated): CTL ${d.load.ctl.toFixed(0)}, ATL ${d.load.atl.toFixed(0)}, TSB ${d.load.tsb.toFixed(0)}.`);
  if (d.weeks.length) {
    L.push("Recent weeks (calculated):");
    for (const wk of d.weeks) L.push(`  week of ${wk.start}${wk === d.weeks.at(-1) ? " (the run's week, up to the run)" : ""}: ${wk.km} km, ${wk.minutes} min, ${wk.runs} run${wk.runs === 1 ? "" : "s"}, longest ${wk.longestKm} km`);
  }
  return L.join("\n");
}

/** Everything the check-in needs for one run, or null when it isn't a key session matched to the plan. */
export async function loadCheckinData(db: SupabaseClient, userId: string, activityId: string): Promise<CheckinData | null> {
  const { data: act } = await db.from("activities").select("id, local_date, sport").eq("id", activityId).eq("user_id", userId).maybeSingle();
  if (!act || act.sport !== "running") return null;
  const { data: planned } = await db.from("planned_workouts").select("*").eq("activity_id", activityId).eq("user_id", userId).maybeSingle();
  if (!planned || !isKeySession(planned)) return null;
  const date = act.local_date as string;
  const [{ data: laps }, { data: splits }, { data: feats }, { data: fb }, { data: state }, runs] = await Promise.all([
    db.from("activity_laps").select("lap_index, timer_s, distance_m, avg_speed, avg_hr, max_hr, intensity").eq("activity_id", activityId).eq("user_id", userId).order("lap_index"),
    db.from("activity_splits").select("split_index, distance_m, pace_s_per_km, avg_hr, partial").eq("activity_id", activityId).eq("user_id", userId).eq("split_length_m", 1000).order("split_index"),
    db.from("activity_features").select("features").eq("activity_id", activityId).eq("user_id", userId).maybeSingle(),
    db.from("workout_feedback").select("rpe, legs, discomfort, notes").eq("activity_id", activityId).eq("user_id", userId).maybeSingle(),
    db.from("fitness_state").select("output").eq("user_id", userId).maybeSingle(),
    loadRuns(db, userId, addDaysIso(date, -27), date),
  ]);
  const run = runs.find((r) => r.id === activityId);
  if (!run) return null;
  const day = ((state?.output?.load ?? []) as LoadDay[]).find((l) => l.date === date) ?? null;
  return {
    run,
    workout: toWorkoutRow(planned),
    laps: (laps ?? []).map((l: any) => ({ index: l.lap_index, distanceM: l.distance_m, timerS: l.timer_s, avgSpeed: l.avg_speed, avgHr: l.avg_hr, maxHr: l.max_hr, intensity: l.intensity })),
    splits: (splits ?? []).map((s: any) => ({ index: s.split_index, distanceM: s.distance_m, paceSPerKm: s.pace_s_per_km, avgHr: s.avg_hr, partial: Boolean(s.partial) })),
    feedback: fb ? { rpe: fb.rpe ?? null, legs: fb.legs ?? null, discomfort: fb.discomfort ?? null, notes: fb.notes ?? null } : null,
    halves: feats?.features?.halves ?? null,
    load: day && { ctl: day.ctl, atl: day.atl, tsb: day.tsb },
    weeks: weeklyTotals(runs, date, 4),
  };
}

/** Plain text from a Responses API result, shortened to a check-in's length. */
export function checkinText(res: { output_text?: string | null; output?: any[] }): string | null {
  const raw =
    res.output_text ??
    (res.output ?? [])
      .filter((o: any) => o?.type === "message")
      .flatMap((m: any) => (m.content ?? []).map((c: any) => (c.type === "output_text" ? c.text : "")))
      .join("");
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 400 ? `${t.slice(0, 397).trimEnd()}…` : t;
}

export interface Checkin {
  text: string;
  workoutId: string;
}

/**
 * The cached check-in for a run, generated when missing or out of date.
 * Returns null for runs that aren't key sessions, and when there's no client
 * (no API key) and nothing current is cached. `db` must be the service-role
 * client; every query is scoped to `userId`.
 */
export async function getOrCreateCheckin(db: SupabaseClient, userId: string, activityId: string, client: OpenAI | null): Promise<Checkin | null> {
  const data = await loadCheckinData(db, userId, activityId);
  if (!data) return null;
  const hash = checkinHash(data.workout.id, data.feedback);
  const { data: cached } = await db.from("coach_checkins").select("input_hash, text").eq("activity_id", activityId).eq("user_id", userId).maybeSingle();
  if (cached?.input_hash === hash) return { text: cached.text, workoutId: data.workout.id };
  if (!client) return null;
  const res = await client.responses.create({
    model: env.coachModel(),
    instructions: CHECKIN_PROMPT,
    input: buildCheckinInput(data),
    reasoning: { effort: "medium" },
    store: false,
    max_output_tokens: 4000,
  });
  const text = checkinText(res as any);
  if (!text) return null;
  const { error } = await db
    .from("coach_checkins")
    .upsert({ activity_id: activityId, user_id: userId, workout_id: data.workout.id, input_hash: hash, text, model: env.coachModel(), prompt_version: CHECKIN_VERSION }, { onConflict: "activity_id" });
  if (error) throw new Error(error.message);
  return { text, workoutId: data.workout.id };
}

/** The run as context for a follow-up in the coach chat: the check-in and what it was written from. */
export async function checkinContext(db: SupabaseClient, userId: string, activityId: string): Promise<string | null> {
  const data = await loadCheckinData(db, userId, activityId);
  if (!data) return null;
  const { data: cached } = await db.from("coach_checkins").select("text").eq("activity_id", activityId).eq("user_id", userId).maybeSingle();
  return [
    `The athlete opened this chat from their run on ${data.run.date} (run id ${data.run.id}) to ask a follow-up.`,
    cached?.text ? `Your check-in on it, shown to them: "${cached.text}"` : null,
    buildCheckinInput(data),
  ]
    .filter(Boolean)
    .join("\n");
}
