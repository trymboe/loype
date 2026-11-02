/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { trainingPaces, predictTimeS } from "@/lib/analytics/fitness/vdot";
import { buildCoachProposal, type CoachWorkout } from "@/lib/coach/proposals";
import { renderSnapshot, valueAt, weeklyTotals, type SnapshotInput } from "@/lib/coach/format";
import { buildWorkout, stepsDistance, stepsDuration, type TargetContext } from "@/lib/planning/workouts";
import type { Baseline } from "@/lib/planning/types";
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

function workout(id: string, date: string, type: CoachWorkout["type"], minutes: number, over: Partial<CoachWorkout> = {}): CoachWorkout {
  const b = buildWorkout({ type, minutes }, ctx);
  return { id, date, type: b.type, title: b.title, objective: b.objective, why: "", steps: b.steps, durationS: stepsDuration(b.steps), distanceM: stepsDistance(b.steps), locked: false, status: "planned", ...over };
}

const today = "2026-11-04"; // Wednesday
const week = [
  workout("w-past", "2026-11-03", "easy", 40, { status: "completed" }),
  workout("w-thr", "2026-11-05", "threshold", 50),
  workout("w-easy", "2026-11-07", "easy", 45),
  workout("w-long", "2026-11-08", "long", 80),
  workout("w-lock", "2026-11-10", "vo2max", 50, { locked: true }),
  workout("w-race", "2026-11-15", "race", 30),
];
const input = (edits: Parameters<typeof buildCoachProposal>[0]["edits"]) =>
  buildCoachProposal({ today, title: "Ease the week", explanation: "You said you're tired after a poor night's sleep.", evidence: ["RPE 8 on Tuesday's easy run"], edits, workouts: week, ctx, unavailableDays: [], planEnd: "2026-11-15" });

describe("coach plan-change proposals", () => {
  it("replaces a hard session with an easy run built by the planner", () => {
    const r = input([{ workoutId: "w-thr", action: "replace", with: "easy", minutes: 30 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.changes[0];
    expect(c.before.type).toBe("threshold");
    expect(c.after.type).toBe("easy");
    expect(Math.round(c.after.durationS / 60)).toBe(30);
    expect(c.after.steps.every((s) => s.kind !== "repeat" && (s.target.zone === "easy" || s.target.zone === "recovery"))).toBe(true);
    expect(c.toDate).toBeUndefined();
  });

  it("never adds load: an easy run can't be longer than what was planned", () => {
    const r = input([{ workoutId: "w-easy", action: "replace", with: "recovery", minutes: 90 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.round(r.changes[0].after.durationS / 60)).toBeLessThanOrEqual(45);
    expect(r.warnings.join(" ")).toMatch(/can't add load/);
  });

  it("turns a session into rest", () => {
    const r = input([{ workoutId: "w-long", action: "replace", with: "rest" }]);
    expect(r.ok && r.changes[0].after.type).toBe("rest");
    expect(r.ok && r.changes[0].after.durationS).toBe(0);
  });

  it("refuses past, completed, locked and race workouts, and unknown ids", () => {
    for (const id of ["w-past", "w-lock", "w-race", "nope"]) {
      const r = input([{ workoutId: id, action: "replace", with: "easy" }]);
      expect(r.ok).toBe(false);
    }
    const r = input([{ workoutId: "w-lock", action: "move", toDate: "2026-11-11" }]);
    expect(!r.ok && r.errors[0]).toMatch(/locked/);
  });

  it("moves a workout and warns about back-to-back hard days", () => {
    const r = input([{ workoutId: "w-thr", action: "move", toDate: "2026-11-07" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes[0]).toMatchObject({ workoutId: "w-thr", date: "2026-11-05", toDate: "2026-11-07" });
    expect(r.changes[0].after).toEqual(r.changes[0].before);
    // threshold on Saturday right before Sunday's long run
    expect(r.warnings.some((w) => /two demanding days in a row/.test(w))).toBe(true);
    expect(r.evidence.some((e) => e.startsWith("Check:"))).toBe(true);
  });

  it("limits moves to a week, inside the plan and not into the past", () => {
    expect(input([{ workoutId: "w-easy", action: "move", toDate: "2026-11-03" }]).ok).toBe(false);
    expect(input([{ workoutId: "w-easy", action: "move", toDate: "2026-11-15" }]).ok).toBe(false);
    expect(input([{ workoutId: "w-easy", action: "move", toDate: "2026-11-20" }]).ok).toBe(false);
    expect(input([{ workoutId: "w-easy", action: "move", toDate: "2026-11-06" }]).ok).toBe(true);
  });

  it("rejects the same workout twice in one proposal", () => {
    const r = input([
      { workoutId: "w-easy", action: "move", toDate: "2026-11-06" },
      { workoutId: "w-easy", action: "replace", with: "rest" },
    ]);
    expect(r.ok).toBe(false);
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

type Script = { content: any[]; stop_reason: string }[];

function fakeClient(script: Script) {
  const requests: any[] = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const step = script.shift();
          if (!step) throw new Error("model called more times than scripted");
          const events = step.content.flatMap((b) =>
            b.type === "text"
              ? [{ type: "content_block_start", content_block: { type: "text", text: "" } }, { type: "content_block_delta", delta: { type: "text_delta", text: b.text } }]
              : [{ type: "content_block_start", content_block: b }],
          );
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => ({ id: "msg", model: params.model, content: step.content, stop_reason: step.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  };
}

async function seed() {
  const userId = "00000000-0000-4000-8000-000000000001";
  const planId = "00000000-0000-4000-8000-0000000000a1";
  const goalId = "00000000-0000-4000-8000-0000000000b1";
  const thrId = "00000000-0000-4000-8000-0000000000c1";
  const thr = workout(thrId, "2026-11-05", "threshold", 50);
  const db = new FakeDb({
    goals: [{ id: goalId, user_id: userId, kind: "10k", name: null, distance_m: 10000, race_date: null, target_time_s: null, target_weekly_km: null }],
    training_plans: [{ id: planId, user_id: userId, goal_id: goalId, status: "active", config: { runDays: [1, 3, 5], unavailableDays: [] }, baseline, race_pace: null, weeks: [], warnings: [], created_at: "2026-11-01T10:00:00Z" }],
    planned_workouts: [
      { id: thrId, plan_id: planId, user_id: userId, date: thr.date, type: thr.type, title: thr.title, objective: thr.objective, why: "", steps: thr.steps, duration_s: thr.durationS, distance_m: thr.distanceM, key: true, locked: false, status: "planned", execution: null, activity_id: null },
    ],
    activities: [
      { id: "00000000-0000-4000-8000-0000000000d1", user_id: userId, sport: "running", duplicate_of: null, local_date: "2026-11-03", start_time: "2026-11-03T06:00:00Z", name: "Morning run", distance_m: 8000, moving_s: 2700, avg_hr: 150, max_hr: 165, elevation_gain_m: 40, is_indoor: false, usable_for_fitness: true, quality: { flags: [] }, classification_override: null },
    ],
  });
  return { db, userId, thrId };
}

describe("coach conversation loop", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  const { runCoachTurn, loadTranscript } = await import("@/lib/coach/service");

  it("answers with the athlete's data, proposes a validated change, and stores everything append-only", async () => {
    const { db, userId, thrId } = await seed();
    const client = fakeClient([
      {
        content: [
          { type: "text", text: "Let me check your week." },
          { type: "tool_use", id: "t1", name: "get_runs", input: { from: "2026-10-28", to: "2026-11-04" } },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [
          { type: "tool_use", id: "t2", name: "propose_plan_change", input: { title: "Easy Thursday", explanation: "You slept badly and your easy run felt hard, so Thursday becomes easy.", evidence: ["Tue 3 Nov: easy run"], changes: [{ workout_id: thrId, action: "replace", replace_with: "easy", minutes: 30, to_date: null }] } },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "I've suggested making Thursday an easy 30 minutes." }], stop_reason: "end_turn" },
    ]);
    const events = [];
    for await (const e of runCoachTurn({ db: db as any, userId, conversationId: null, text: "I'm tired, can we adapt my week?", today, timezone: "Asia/Ho_Chi_Minh" }, client as any)) events.push(e);

    // the first request carries the data snapshot in the user turn, not in the system prompt
    const first = client.requests[0];
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.messages[0].content[0].text).toMatch(/<athlete_data>[\s\S]*Morning run[\s\S]*Threshold/);
    expect(first.messages[0].content[1].text).toBe("I'm tired, can we adapt my week?");
    expect(JSON.stringify(first.system)).not.toMatch(/Morning run/);
    // the tool result went back to the model
    expect(JSON.stringify(client.requests[1].messages.at(-1))).toMatch(/1 run\(s\)/);
    // the proposal is pending, linked to the conversation, and nothing in the plan changed yet
    const proposal = db.rows("adaptation_proposals")[0];
    expect(proposal).toMatchObject({ rule: "coach", title: "Easy Thursday", conversation_id: db.rows("coach_conversations")[0].id }); // status defaults to pending in the database
    expect(proposal.changes[0].after.type).toBe("easy");
    expect(db.rows("planned_workouts")[0].type).toBe("threshold");
    expect(events.filter((e) => e.type === "proposal")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done" });

    // stored verbatim, in order
    const msgs = structuredClone(db.rows("coach_messages"));
    expect(msgs.map((m) => m.kind)).toEqual(["user", "assistant", "tool_results", "assistant", "tool_results", "assistant"]);
    expect(msgs.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    const conv = db.rows("coach_conversations")[0];
    const transcript = await loadTranscript(db as any, userId, conv.id);
    expect(transcript).toHaveLength(2);
    expect(transcript[1].text).toBe("Let me check your week.\n\nI've suggested making Thursday an easy 30 minutes.");
    expect(transcript[1].proposalIds).toEqual([proposal.id]);

    // the next turn replays the stored history exactly and skips an unchanged snapshot
    const client2 = fakeClient([{ content: [{ type: "text", text: "Yes." }], stop_reason: "end_turn" }]);
    for await (const e of runCoachTurn({ db: db as any, userId, conversationId: conv.id, text: "Thanks. Anything else?", today, timezone: "Asia/Ho_Chi_Minh" }, client2 as any)) void e;
    const replay = client2.requests[0].messages;
    expect(replay.slice(0, 6)).toEqual(msgs.map((m) => ({ role: m.role, content: m.content })));
    // the plan now has a pending proposal, so the data changed and a fresh snapshot is sent
    expect(replay[6].content).toHaveLength(2);
    expect(replay[6].content[0].text).toMatch(/\[from coach\] Easy Thursday/);
    expect(replay[6].content[1]).toEqual({ type: "text", text: "Thanks. Anything else?" });
    expect(client2.requests[0].system).toEqual(first.system);

    // nothing changed since: the snapshot isn't repeated
    const client3 = fakeClient([{ content: [{ type: "text", text: "No." }], stop_reason: "end_turn" }]);
    for await (const e of runCoachTurn({ db: db as any, userId, conversationId: conv.id, text: "Ok", today, timezone: "Asia/Ho_Chi_Minh" }, client3 as any)) void e;
    expect(client3.requests[0].messages.at(-1).content).toEqual([{ type: "text", text: "Ok" }]);
  });

  it("returns invalid tool input to the model as an error instead of acting on it", async () => {
    const { db, userId } = await seed();
    const client = fakeClient([
      { content: [{ type: "tool_use", id: "t1", name: "propose_plan_change", input: { title: "x", explanation: "short", evidence: [], changes: [] } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Sorry." }], stop_reason: "end_turn" },
    ]);
    for await (const e of runCoachTurn({ db: db as any, userId, conversationId: null, text: "Change my plan", today, timezone: "UTC" }, client as any)) void e;
    const result = client.requests[1].messages.at(-1).content[0];
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(db.rows("adaptation_proposals")).toHaveLength(0);
  });

  it("forbids tools on the last round so a turn always ends with an answer", async () => {
    const { db, userId } = await seed();
    const loop = Array.from({ length: 7 }, (_, i) => ({ content: [{ type: "tool_use", id: `t${i}`, name: "get_weekly_volume", input: { weeks: 4 } }], stop_reason: "tool_use" }));
    const client = fakeClient([...loop, { content: [{ type: "text", text: "Here's what I found." }], stop_reason: "end_turn" }]);
    for await (const e of runCoachTurn({ db: db as any, userId, conversationId: null, text: "Volume?", today, timezone: "UTC" }, client as any)) void e;
    expect(client.requests).toHaveLength(8);
    expect(client.requests[7].tool_choice).toEqual({ type: "none" });
    expect(client.requests[0].tool_choice).toEqual({ type: "auto" });
  });
});
