/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { trainingPaces, predictTimeS } from "@/lib/analytics/fitness/vdot";
import { renderSnapshot, valueAt, weeklyTotals, type SnapshotInput } from "@/lib/coach/format";
import { buildWorkout, stepsDistance, stepsDuration, type TargetContext } from "@/lib/planning/workouts";
import type { Baseline, WorkoutType } from "@/lib/planning/types";
import { FakeDb } from "./fake-db";

const baseline: Baseline = {
  asOf: "2026-11-02",
  vdot: 41.5,
  vdotRange: [39.5, 43.5],
  vdotConfidence: "medium",
  paceZones: trainingPaces(41.5),
  hrZones: null,
  thresholdHr: 170,
  weeklyMinutes: 150,
  weeklyKm: 25,
  runsPerWeek: 3,
  consistency: 0.9,
  longestRunMinutes: 60,
  predictions: [5000, 10000].map((d) => ({ distanceM: d, timeS: predictTimeS(41.5, d) })),
};
const ctx: TargetContext = { baseline, racePace: null, raceLabel: null };
const today = "2026-11-04"; // Wednesday

const U = "00000000-0000-4000-8000-000000000001";
const PLAN = "00000000-0000-4000-8000-0000000000a1";
const GOAL = "00000000-0000-4000-8000-0000000000b1";
const id = (n: number) => `00000000-0000-4000-8000-0000000000${(0xc0 + n).toString(16)}`;

function row(n: number, date: string, type: WorkoutType, minutes: number, over: Record<string, unknown> = {}) {
  const b = buildWorkout({ type, minutes }, ctx);
  return { id: id(n), plan_id: PLAN, user_id: U, date, original_date: date, type: b.type, title: b.title, objective: b.objective, why: "", steps: b.steps, duration_s: stepsDuration(b.steps), distance_m: stepsDistance(b.steps), key: false, locked: false, status: "planned", execution: null, activity_id: null, route_id: null, source: "generator", ...over };
}

function seed() {
  const workouts = [
    row(0, "2026-11-03", "easy", 40, { status: "completed" }),
    row(1, "2026-11-05", "threshold", 50, { key: true }),
    row(2, "2026-11-07", "easy", 45),
    row(3, "2026-11-08", "long", 60, { key: true }),
    row(4, "2026-11-10", "vo2max", 50, { locked: true }),
    row(5, "2026-11-30", "race", 45),
  ];
  return new FakeDb({
    goals: [{ id: GOAL, user_id: U, kind: "10k", name: null, distance_m: 10000, race_date: null, target_time_s: null, target_weekly_km: null }],
    training_plans: [{ id: PLAN, user_id: U, goal_id: GOAL, status: "active", current_version: 1, config: { runDays: [1, 3, 5, 6], unavailableDays: [0, 2, 4], runsPerWeek: null, maxWeeklyMinutes: null, includeIntervals: true, includeLongRuns: true, includeStrides: false, longRunDay: 6 }, baseline, race_pace: null, weeks: [], warnings: [], created_at: "2026-11-01T10:00:00Z" }],
    plan_versions: [{ id: "v1", plan_id: PLAN, user_id: U, version: 1, reason: "Plan created", created_by: "generator", created_at: "2026-11-01T10:00:00Z", snapshot: { workouts: structuredClone(workouts) } }],
    planned_workouts: workouts,
    activities: [
      { id: "00000000-0000-4000-8000-0000000000d1", user_id: U, sport: "running", duplicate_of: null, local_date: "2026-11-03", start_time: "2026-11-03T06:00:00Z", name: "Morning run", distance_m: 8000, moving_s: 2700, avg_hr: 150, max_hr: 165, elevation_gain_m: 40, is_indoor: false, usable_for_fitness: true, quality: { flags: [] }, classification_override: null },
    ],
  });
}

const workoutRow = (db: FakeDb, n: number) => db.rows("planned_workouts").find((w) => w.id === id(n))!;

describe("coach tools", async () => {
  const { runTool } = await import("@/lib/coach/tools");
  const call = (db: FakeDb, name: string, input: unknown) => {
    const tctx = { db: db as any, userId: U, today, actions: [] as any[] };
    return runTool(name, input, tctx).then((out) => ({ out, actions: tctx.actions }));
  };

  it("skips and swaps sessions like the workout buttons, recording a plan version to undo to", async () => {
    const db = seed();
    const r = await call(db, "edit_workout", { workout_id: id(1), action: "easy", date: null, confirmed: false });
    expect(r.out).toMatch(/^Done: Swapped/);
    expect(workoutRow(db, 1).type).toBe("easy");
    expect(r.actions).toEqual([expect.objectContaining({ kind: "plan", planId: PLAN, versionBefore: 1 })]);
    expect(db.rows("plan_versions")).toHaveLength(2);
    const s = await call(db, "edit_workout", { workout_id: id(2), action: "skip", date: null, confirmed: false });
    expect(s.out).toMatch(/Removed/);
    expect(workoutRow(db, 2).status).toBe("skipped");
  });

  it("refuses completed, locked and race sessions and other people's workouts", async () => {
    const db = seed();
    expect((await call(db, "edit_workout", { workout_id: id(0), action: "rest", date: null, confirmed: false })).out).toMatch(/completed/);
    expect((await call(db, "edit_workout", { workout_id: id(4), action: "rest", date: null, confirmed: false })).out).toMatch(/locked/);
    expect((await call(db, "replace_workout", { workout_id: id(5), type: "easy", minutes: 30, intensity: null, confirmed: false })).out).toMatch(/race/);
    expect((await call(db, "edit_workout", { workout_id: "00000000-0000-4000-8000-0000000000ff", action: "skip", date: null, confirmed: false })).out).toMatch(/isn't in the active plan/);
    expect(db.rows("plan_versions")).toHaveLength(1);
  });

  it("turns intervals into a long run, but warns first when it's a big jump and only acts once confirmed", async () => {
    const db = seed();
    const first = await call(db, "replace_workout", { workout_id: id(1), type: "long", minutes: 120, intensity: null, confirmed: false });
    expect(first.out).toMatch(/^Not changed yet/);
    expect(workoutRow(db, 1).type).toBe("threshold");
    expect(first.actions).toHaveLength(0);
    const ok = await call(db, "replace_workout", { workout_id: id(1), type: "long", minutes: 120, intensity: null, confirmed: true });
    expect(ok.out).toMatch(/^Done: Changed/);
    expect(workoutRow(db, 1)).toMatchObject({ type: "long", source: "athlete" });
    expect(Math.round(workoutRow(db, 1).duration_s / 60)).toBe(120);
  });

  it("adds a session on a free day and checks the schedule", async () => {
    const db = seed();
    const r = await call(db, "add_workout", { date: "2026-11-12", type: "easy", minutes: 30, intensity: null, confirmed: false });
    expect(r.out).toMatch(/^Done: Added/);
    expect(db.rows("planned_workouts").filter((w) => w.date === "2026-11-12")).toHaveLength(1);
    // the day after a VO2max session, another hard one is flagged
    const hard = await call(db, "add_workout", { date: "2026-11-09", type: "threshold", minutes: null, intensity: null, confirmed: false });
    expect(hard.out).toMatch(/^Not added yet/);
    expect((await call(db, "add_workout", { date: "2026-11-01", type: "easy", minutes: 30, intensity: null, confirmed: false })).out).toMatch(/past/);
  });

  it("warns before a move that breaks the schedule", async () => {
    const db = seed();
    const r = await call(db, "edit_workout", { workout_id: id(1), action: "move", date: "2026-11-09", confirmed: false });
    expect(r.out).toMatch(/^Not moved yet/);
    expect(workoutRow(db, 1).date).toBe("2026-11-05");
    const ok = await call(db, "edit_workout", { workout_id: id(1), action: "move", date: "2026-11-09", confirmed: true });
    expect(ok.out).toMatch(/^Done: Moved/);
    expect(workoutRow(db, 1).date).toBe("2026-11-09");
  });

  it("flags a jump in runs per week against recent training before changing settings", async () => {
    const db = seed();
    const r = await call(db, "change_plan_settings", { run_days: [0, 1, 2, 3, 4, 5, 6], runs_per_week: 6, long_run_day: null, max_weekly_hours: null, include_intervals: null, include_long_runs: null, include_strides: null, volume: null, intensity: null, target_time: null, target_weekly_km: null, race_name: null, confirmed: false });
    expect(r.out).toMatch(/^Not changed yet[\s\S]*6 runs a week/);
    expect(db.rows("training_plans")[0].config.runsPerWeek).toBeNull();
  });

  it("reworks many sessions at once as one version, checking the plan as a whole", async () => {
    const db = seed();
    const v0 = db.rows("plan_versions").length;
    const ops = [
      { action: "replace", workout_id: id(1), date: null, type: "long", minutes: 55, intensity: null },
      { action: "move", workout_id: id(3), date: "2026-11-07", type: null, minutes: null, intensity: null },
      { action: "move", workout_id: id(2), date: "2026-11-08", type: null, minutes: null, intensity: null },
      { action: "resize", workout_id: id(3), date: null, type: null, minutes: 50, intensity: null },
      { action: "add", workout_id: null, date: "2026-11-12", type: "easy", minutes: 30, intensity: null },
    ];
    const { out, actions } = await call(db, "edit_plan", { reason: "Lighter, simpler week", operations: ops, confirmed: false });
    expect(out, out).toMatch(/^Done: 5 changes/);
    expect(workoutRow(db, 1).type).toBe("long");
    expect(workoutRow(db, 2).date).toBe("2026-11-08");
    expect(workoutRow(db, 3).date).toBe("2026-11-07");
    expect(Math.round(workoutRow(db, 3).duration_s / 60)).toBe(50);
    expect(db.rows("planned_workouts")).toHaveLength(7);
    expect(db.rows("plan_versions").length).toBe(v0 + 1);
    expect(actions).toHaveLength(1);
    expect(actions[0].summary).toMatch(/Lighter, simpler week \(4 sessions changed\)/);
  });

  it("changes nothing when one operation is invalid", async () => {
    const db = seed();
    const ops = [
      { action: "skip", workout_id: id(2), date: null, type: null, minutes: null, intensity: null },
      { action: "skip", workout_id: id(0), date: null, type: null, minutes: null, intensity: null },
      { action: "resize", workout_id: id(4), date: null, type: null, minutes: 30, intensity: null },
    ];
    const { out, actions } = await call(db, "edit_plan", { reason: "x", operations: ops, confirmed: false });
    expect(out).toMatch(/Nothing changed[\s\S]*#2 skip[\s\S]*completed[\s\S]*#3 resize[\s\S]*locked/);
    expect(workoutRow(db, 2).status).toBe("planned");
    expect(actions).toHaveLength(0);
  });

  it("warns before a big jump in weekly time and applies it once confirmed", async () => {
    const db = seed();
    const input = { from: today, to: "2026-11-08", percent: 60, sessions: "all", reason: "More volume", confirmed: false };
    const first = await call(db, "scale_plan", input);
    expect(first.out).toMatch(/Not changed yet[\s\S]*week of 2026-11-02/);
    expect(Math.round(workoutRow(db, 3).duration_s / 60)).toBe(60);
    const second = await call(db, "scale_plan", { ...input, confirmed: true });
    expect(second.out).toMatch(/^Done/);
    expect(Math.round(workoutRow(db, 3).duration_s / 60)).toBe(96);
    expect(workoutRow(db, 4).duration_s).toBe(row(4, "2026-11-10", "vo2max", 50).duration_s); // locked and outside the range
  });

  it("shows the whole plan week by week", async () => {
    const db = seed();
    db.rows("training_plans")[0].weeks = [
      { index: 0, start: "2026-11-02", phase: "base", targetMinutes: 150 },
      { index: 1, start: "2026-11-09", phase: "build", targetMinutes: 160 },
    ];
    const { out } = await call(db, "get_plan_overview", {});
    expect(out).toMatch(/Week 1 \(2026-11-02, base, this week\): target 150 min/);
    expect(out).toMatch(/2026-11-10 \w+ vo2max .*\[locked\]/);
  });

  it("rejects invalid input instead of guessing", async () => {
    const db = seed();
    await expect(call(db, "edit_workout", { workout_id: "nope", action: "skip", date: null, confirmed: false })).rejects.toThrow(/workout_id/);
  });
});

describe("coach data formatting", () => {
  it("adds up Monday-based weeks", () => {
    const w = weeklyTotals(
      [
        { date: "2026-10-27", distanceM: 5000, movingS: 1800 },
        { date: "2026-11-02", distanceM: 8000, movingS: 2700 },
        { date: "2026-11-04", distanceM: 12000, movingS: 4200 },
        { date: "2026-08-01", distanceM: 9000, movingS: 3000 },
      ],
      today,
      2,
    );
    expect(w).toEqual([
      { start: "2026-10-26", km: 5, minutes: 30, runs: 1, longestKm: 5 },
      { start: "2026-11-02", km: 20, minutes: 115, runs: 2, longestKm: 12 },
    ]);
  });

  it("picks the latest value on or before a date", () => {
    const pts = [
      { asOf: "2026-08-02", kind: "retrospective" as const, value: 40, lower: null, upper: null, confidence: "medium" },
      { asOf: "2026-10-25", kind: "retrospective" as const, value: 41, lower: null, upper: null, confidence: "medium" },
    ];
    expect(valueAt(pts, "2026-09-01")?.value).toBe(40);
    expect(valueAt(pts, "2026-11-04")?.value).toBe(41);
    expect(valueAt(pts, "2026-01-01")).toBeNull();
  });

  it("says when there is no fitness estimate or plan instead of inventing one", () => {
    const s: SnapshotInput = {
      today,
      timezone: "Asia/Ho_Chi_Minh",
      profile: null,
      fitness: { asOf: today, estimate: { withheld: true, asOf: today, reason: "Not enough runs with reliable data", evidence: [] }, predictions: null, threshold: null, paceZones: null, hrZones: null, physiology: null, load: [], efficiency: null },
      fitnessComputedAt: null,
      history: {},
      weeks: [],
      recentRuns: [],
      totalRuns: 0,
      firstRunDate: null,
      plan: null,
      workouts: [],
      proposals: [],
      wellness: [],
    };
    const text = renderSnapshot(s);
    expect(text).toMatch(/WITHHELD — Not enough runs/);
    expect(text).toMatch(/No active plan/);
    expect(text).toMatch(/No wellness data synced/);
    expect(text).not.toMatch(/Race predictions/);
  });
});

// ---------------------------------------------------------------------------
// The conversation loop, with a scripted model and an in-memory database
// ---------------------------------------------------------------------------

type Out = { type: "text"; text: string } | { type: "call"; name: string; args: unknown };

/** Stands in for client.responses.stream: each call plays the next scripted response. */
function fakeClient(script: Out[][]) {
  const requests: any[] = [];
  let n = 0;
  return {
    requests,
    responses: {
      stream(params: any) {
        requests.push(structuredClone(params));
        const step = script.shift();
        if (!step) throw new Error("model called more times than scripted");
        const r = n++;
        const output = step.map((o, i) =>
          o.type === "text"
            ? { type: "message", id: `msg_${r}_${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: o.text, annotations: [] }] }
            : // like the real SDK's stream helper, which adds parsed_arguments (the API rejects it as input)
              { type: "function_call", id: `fc_${r}_${i}`, call_id: `call_${r}_${i}`, name: o.name, arguments: JSON.stringify(o.args), parsed_arguments: null, status: "completed" },
        );
        const reasoning = { type: "reasoning", id: `rs_${r}`, summary: [], encrypted_content: `enc-${r}` };
        const events: any[] = output.flatMap((o: any): any[] =>
          o.type === "message" ? [{ type: "response.output_text.delta", delta: o.content[0].text }] : [{ type: "response.output_item.added", item: o }],
        );
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalResponse: async () => ({ id: `resp_${r}`, model: params.model, status: "completed", output: [reasoning, ...output], usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      },
    },
  };
}

describe("coach conversation loop", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test");
  const { runCoachTurn, loadTranscript, undoCoachActions } = await import("@/lib/coach/service");
  const turn = async (db: FakeDb, client: any, text: string, conversationId: string | null = null) => {
    const events: any[] = [];
    for await (const e of runCoachTurn({ db: db as any, userId: U, conversationId, text, today, timezone: "Asia/Ho_Chi_Minh" }, client)) events.push(e);
    return events;
  };

  it("changes the plan when asked, shows what changed, stores everything append-only and can undo", async () => {
    const db = seed();
    const client = fakeClient([
      [{ type: "call", name: "get_plan_workouts", args: { from: today, to: "2026-11-10" } }],
      [
        { type: "call", name: "edit_workout", args: { workout_id: id(2), action: "skip", date: null, confirmed: false } },
        { type: "call", name: "edit_workout", args: { workout_id: id(3), action: "move", date: "2026-11-07", confirmed: false } },
      ],
      [{ type: "text", text: "Done. I dropped Saturday's easy run and moved the long run to Saturday, so Sunday is free." }],
    ]);
    const events = await turn(db, client, "I can't run on Sunday this week, and I only have time for two runs.");

    // the data snapshot is in the user message, not the instructions; storage and replay settings
    const first = client.requests[0];
    expect(first.model).toBe("gpt-6-luna");
    expect(first.store).toBe(false);
    expect(first.include).toEqual(["reasoning.encrypted_content"]);
    expect(first.input[0].content[0].text).toMatch(/<athlete_data>[\s\S]*Morning run[\s\S]*Threshold/);
    expect(first.input[0].content[1].text).toMatch(/only have time for two runs/);
    expect(first.instructions).not.toMatch(/Morning run/);
    // tool outputs went back, after the model's own items (reasoning included)
    const second = client.requests[1].input;
    expect(second.at(-2)).toMatchObject({ type: "function_call", name: "get_plan_workouts" });
    expect(second.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_0_0" });
    expect(second.some((i: any) => i.type === "reasoning" && i.encrypted_content === "enc-0")).toBe(true);

    expect(workoutRow(db, 2).status).toBe("skipped");
    expect(workoutRow(db, 3).date).toBe("2026-11-07");
    const acts = events.filter((e) => e.type === "actions");
    expect(acts).toHaveLength(1);
    expect(acts[0].items.map((a: any) => a.summary)).toEqual([expect.stringMatching(/Removed/), expect.stringMatching(/Moved/)]);
    expect(events.at(-1)).toEqual({ type: "done" });

    const msgs = structuredClone(db.rows("coach_messages"));
    expect(msgs.map((m) => m.kind)).toEqual(["user", "assistant", "tool_results", "assistant", "tool_results", "assistant"]);
    const conv = db.rows("coach_conversations")[0];
    const transcript = await loadTranscript(db as any, U, conv.id);
    expect(transcript).toHaveLength(2);
    expect(transcript[1].text).toMatch(/^Done\. I dropped/);
    expect(transcript[1].actions).toHaveLength(2);

    // only fields the API accepts as input are stored and replayed
    expect(JSON.stringify(msgs)).not.toMatch(/parsed_arguments/);
    expect(JSON.stringify(client.requests.at(-1).input)).not.toMatch(/parsed_arguments/);
    // the next turn replays the stored items exactly, with the same instructions
    const client2 = fakeClient([[{ type: "text", text: "Sure." }]]);
    await turn(db, client2, "Thanks", conv.id);
    const replay = client2.requests[0].input;
    expect(replay.slice(0, -1)).toEqual(msgs.flatMap((m) => m.content));
    expect(client2.requests[0].instructions).toBe(first.instructions);
    // the plan changed since the last snapshot, so a fresh one goes with this message
    expect(replay.at(-1).content).toHaveLength(2);
    // nothing changed since: no snapshot this time
    const client3 = fakeClient([[{ type: "text", text: "Ok." }]]);
    await turn(db, client3, "Ok", conv.id);
    expect(client3.requests[0].input.at(-1).content).toEqual([{ type: "input_text", text: "Ok" }]);

    // Undo puts both workouts back
    const r = await undoCoachActions(db as any, U, transcript[1].actionMessageIds, today);
    expect(r).toEqual({ undone: 2 });
    expect(workoutRow(db, 2).status).toBe("planned");
    expect(workoutRow(db, 3).date).toBe("2026-11-08");
    expect((await loadTranscript(db as any, U, conv.id))[1].undone).toBe(true);
    expect(await undoCoachActions(db as any, U, transcript[1].actionMessageIds, today)).toEqual({ error: "Already undone" });
  });

  it("undo removes sessions the coach added", async () => {
    const db = seed();
    const client = fakeClient([[{ type: "call", name: "add_workout", args: { date: "2026-11-12", type: "easy", minutes: 30, intensity: null, confirmed: false } }], [{ type: "text", text: "Added." }]]);
    await turn(db, client, "Add an easy run next Thursday");
    expect(db.rows("planned_workouts")).toHaveLength(7);
    const t = await loadTranscript(db as any, U, db.rows("coach_conversations")[0].id);
    expect(await undoCoachActions(db as any, U, t[1].actionMessageIds, today)).toEqual({ undone: 1 });
    expect(db.rows("planned_workouts")).toHaveLength(6);
  });

  it("replays older stored items without the SDK's extra fields", async () => {
    const db = seed();
    await turn(db, fakeClient([[{ type: "call", name: "get_routes", args: {} }], [{ type: "text", text: "None yet." }]]), "Any routes?");
    const conv = db.rows("coach_conversations")[0];
    for (const m of db.rows("coach_messages")) for (const c of m.content) if (c.type === "function_call") c.parsed_arguments = {};
    const client = fakeClient([[{ type: "text", text: "Ok." }]]);
    await turn(db, client, "Ok", conv.id);
    expect(JSON.stringify(client.requests[0].input)).not.toMatch(/parsed_arguments/);
  });

  it("starts a plan earlier, rebuilding it from that week, and undoes that", async () => {
    const db = seed();
    const plan = db.rows("training_plans")[0];
    plan.config = { ...plan.config, startDate: "2026-11-09", weeks: 8 };
    plan.goal_id = GOAL;
    plan.weeks = [{ index: 0, start: "2026-11-09", phase: "base" }];
    const before = structuredClone(db.rows("planned_workouts"));
    const client = fakeClient([[{ type: "call", name: "start_plan_earlier", args: { start_date: today } }], [{ type: "text", text: "Started." }]]);
    const events = await turn(db, client, "Start the plan this week");
    const out = client.requests[1].input.at(-1).output;
    expect(out).toMatch(/now starts on 2026-11-04/);
    const p = db.rows("training_plans")[0];
    expect(p.config.startDate).toBe(today);
    expect(p.weeks[0].start).toBe("2026-11-02");
    // finished and locked sessions stay; nothing new lands before the new start
    expect(workoutRow(db, 0).status).toBe("completed");
    expect(workoutRow(db, 4).locked).toBe(true);
    expect(db.rows("planned_workouts").filter((w) => w.source === "generator" && w.status !== "completed").every((w) => w.date >= today)).toBe(true);
    expect(events.find((e) => e.type === "actions").items[0].summary).toMatch(/Moved the plan's start/);

    const t = await loadTranscript(db as any, U, db.rows("coach_conversations")[0].id);
    expect(await undoCoachActions(db as any, U, t[1].actionMessageIds, today)).toEqual({ undone: 1 });
    const after = db.rows("training_plans")[0];
    expect(after.config.startDate).toBe("2026-11-09");
    expect(after.weeks[0].start).toBe("2026-11-09");
    const ids = (rows: any[]) => rows.map((w) => `${w.id} ${w.date} ${w.status}`).sort();
    expect(ids(db.rows("planned_workouts"))).toEqual(ids(before));
  });

  it("can start a plan that was pushed back because the race is far away", async () => {
    const db = seed();
    const plan = db.rows("training_plans")[0];
    db.rows("goals")[0].race_date = "2027-04-24";
    plan.config = { ...plan.config, startDate: today, weeks: 12 };
    plan.weeks = [{ index: 0, start: "2026-11-09", phase: "base" }];
    const { runTool } = await import("@/lib/coach/tools");
    const tctx = { db: db as any, userId: U, today, actions: [] as any[] };
    expect(await runTool("start_plan_earlier", { start_date: today }, tctx)).toMatch(/now starts on 2026-11-04/);
    const p = db.rows("training_plans")[0];
    expect(p.weeks[0].start).toBe("2026-11-02");
    expect(p.weeks.at(-1).start).toBe("2027-04-19");
    expect(db.rows("planned_workouts").some((w) => w.date > today && w.date <= "2026-11-08" && w.type !== "rest" && w.status === "planned")).toBe(true);
  });

  it("won't move a plan's start into the past or later", async () => {
    const db = seed();
    db.rows("training_plans")[0].config.startDate = "2026-11-09";
    const { runTool } = await import("@/lib/coach/tools");
    const tctx = { db: db as any, userId: U, today, actions: [] as any[] };
    expect(await runTool("start_plan_earlier", { start_date: "2026-11-01" }, tctx)).toMatch(/past/);
    expect(await runTool("start_plan_earlier", { start_date: "2026-11-10" }, tctx)).toMatch(/already starts/);
    expect(tctx.actions).toHaveLength(0);
  });

  it("undoes a whole-plan rework in one go", async () => {
    const db = seed();
    const before = structuredClone(db.rows("planned_workouts"));
    const ops = [
      { action: "replace", workout_id: id(1), date: null, type: "easy", minutes: 30, intensity: null },
      { action: "skip", workout_id: id(2), date: null, type: null, minutes: null, intensity: null },
      { action: "add", workout_id: null, date: "2026-11-12", type: "easy", minutes: 30, intensity: null },
    ];
    await turn(db, fakeClient([[{ type: "call", name: "edit_plan", args: { reason: "Easier week", operations: ops, confirmed: false } }], [{ type: "text", text: "Done." }]]), "Make this week easier");
    expect(workoutRow(db, 1).type).toBe("easy");
    const t = await loadTranscript(db as any, U, db.rows("coach_conversations")[0].id);
    expect(await undoCoachActions(db as any, U, t[1].actionMessageIds, today)).toEqual({ undone: 1 });
    const key = (rows: any[]) => rows.map((w) => `${w.id} ${w.date} ${w.type} ${w.status}`).sort();
    expect(key(db.rows("planned_workouts"))).toEqual(key(before));
  });

  it("returns invalid tool input to the model instead of acting on it", async () => {
    const db = seed();
    const client = fakeClient([[{ type: "call", name: "edit_workout", args: { workout_id: id(2), action: "explode" } }], [{ type: "text", text: "Sorry." }]]);
    const events = await turn(db, client, "Change my plan");
    expect(client.requests[1].input.at(-1).output).toMatch(/^Invalid input/);
    expect(events.some((e) => e.type === "actions")).toBe(false);
    expect(workoutRow(db, 2).status).toBe("planned");
  });

  it("forbids tools on the last round so a turn always ends with an answer", async () => {
    const db = seed();
    const loop: Out[][] = Array.from({ length: 15 }, () => [{ type: "call", name: "get_weekly_volume", args: { weeks: 4 } }]);
    const client = fakeClient([...loop, [{ type: "text", text: "Here's what I found." }]]);
    await turn(db, client, "Volume?");
    expect(client.requests).toHaveLength(16);
    expect(client.requests[15].tool_choice).toBe("none");
    expect(client.requests[0].tool_choice).toBe("auto");
  });
});
