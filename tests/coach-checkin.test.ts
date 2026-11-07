/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { predictTimeS, trainingPaces } from "@/lib/analytics/fitness/vdot";
import { buildCheckinInput, checkinContext, checkinHash, checkinText, getOrCreateCheckin, isKeySession, loadCheckinData, plannedReps } from "@/lib/coach/checkin";
import { buildWorkout, stepsDistance, stepsDuration, type TargetContext } from "@/lib/planning/workouts";
import type { Baseline, WorkoutType } from "@/lib/planning/types";
import { KEEP_FOR_TRAINING, keepFor } from "@/lib/privacy/delete";
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

const U = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000d1";
const EASY_RUN = "00000000-0000-4000-8000-0000000000d2";
const W = "00000000-0000-4000-8000-0000000000c1";
const W_EASY = "00000000-0000-4000-8000-0000000000c2";

function workout(id: string, activityId: string, date: string, type: WorkoutType, minutes: number, over: Record<string, unknown> = {}) {
  const b = buildWorkout({ type, minutes }, ctx);
  return { id, plan_id: "p1", user_id: U, date, original_date: date, type: b.type, title: b.title, steps: b.steps, duration_s: stepsDuration(b.steps), distance_m: stepsDistance(b.steps), key: false, locked: false, status: "completed", activity_id: activityId, ...over };
}

const activity = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: U,
  sport: "running",
  duplicate_of: null,
  local_date: date,
  start_time: `${date}T06:00:00Z`,
  name: "Morning run",
  distance_m: 10000,
  moving_s: 3000,
  avg_hr: 162,
  max_hr: 181,
  elevation_gain_m: 30,
  is_indoor: false,
  usable_for_fitness: true,
  quality: { flags: [] },
  classification_override: null,
  ...over,
});

function seed() {
  return new FakeDb({
    activities: [activity(RUN, "2026-11-05"), activity(EASY_RUN, "2026-11-03", { distance_m: 6000, moving_s: 2200, avg_hr: 140 }), activity("00000000-0000-4000-8000-0000000000d3", "2026-10-20")],
    planned_workouts: [
      workout(W, RUN, "2026-11-05", "vo2max", 50, {
        key: true,
        execution: { verdict: "harder", workPace: 262, targetPace: [270, 280], durationRatio: 1.02, paceDeltaPct: 4.6, avgHr: 162, notes: ["Work pace 4:22/km was faster than the target 4:30–4:40/km."] },
      }),
      workout(W_EASY, EASY_RUN, "2026-11-03", "easy", 40),
    ],
    activity_laps: [
      { activity_id: RUN, user_id: U, lap_index: 0, timer_s: 900, distance_m: 2500, avg_speed: 2.78, avg_hr: 140, max_hr: 150, intensity: "warmup" },
      { activity_id: RUN, user_id: U, lap_index: 1, timer_s: 180, distance_m: 690, avg_speed: 3.83, avg_hr: 172, max_hr: 180, intensity: "active" },
      { activity_id: RUN, user_id: U, lap_index: 2, timer_s: 120, distance_m: 300, avg_speed: 2.5, avg_hr: 150, max_hr: 172, intensity: "rest" },
      { activity_id: RUN, user_id: U, lap_index: 3, timer_s: 180, distance_m: 700, avg_speed: 3.89, avg_hr: 178, max_hr: 181, intensity: "active" },
    ],
    activity_splits: [
      { activity_id: RUN, user_id: U, split_index: 0, split_length_m: 1000, distance_m: 1000, pace_s_per_km: 360, avg_hr: 138, partial: false },
      { activity_id: RUN, user_id: U, split_index: 1, split_length_m: 1000, distance_m: 1000, pace_s_per_km: 268, avg_hr: 170, partial: false },
    ],
    activity_features: [{ activity_id: RUN, user_id: U, features: { halves: [{ movingS: 1200, distanceM: 4000, avgHr: 155 }, { movingS: 1200, distanceM: 4000, avgHr: 166 }] } }],
    activity_scores: [{ activity_id: RUN, user_id: U, classification: "intervals", ef: 1.5, decoupling_pct: 7.2, trimp: 95 }],
    workout_feedback: [{ activity_id: RUN, user_id: U, rpe: 9, legs: "heavy", discomfort: "left achilles tight", notes: null }],
    fitness_state: [{ user_id: U, output: { load: [{ date: "2026-11-04", run: 50, other: 0, ctl: 40, atl: 50, tsb: -10 }, { date: "2026-11-05", run: 95, other: 0, ctl: 41.2, atl: 52.7, tsb: -12.3 }] } }],
  });
}

/** Stands in for client.responses.create. */
function fakeClient(replies: string[]) {
  const requests: any[] = [];
  return {
    requests,
    responses: {
      create: vi.fn(async (params: any) => {
        requests.push(params);
        const text = replies.shift();
        if (text == null) throw new Error("model called more times than expected");
        return { output_text: text, output: [] };
      }),
    },
  };
}

describe("key sessions", () => {
  it("covers long runs, intervals, tempo/threshold, time trials, races and anything marked key", () => {
    for (const t of ["long", "progressive_long", "vo2max", "repetitions", "threshold", "tempo", "race", "time_trial"]) expect(isKeySession({ type: t })).toBe(true);
    for (const t of ["easy", "recovery", "strides"]) expect(isKeySession({ type: t })).toBe(false);
    expect(isKeySession({ type: "easy", key: true })).toBe(true);
  });
});

describe("check-in input", () => {
  it("lays out planned targets against what was measured, feedback, drift and recent load", async () => {
    const data = (await loadCheckinData(seed() as any, U, RUN))!;
    expect(data).not.toBeNull();
    const text = buildCheckinInput(data);
    expect(text).toMatch(/Planned session: .*\[vo2max\].*KEY session.*steps: /);
    expect(text).toContain(`Planned work reps: ${plannedReps(data.workout.steps)}. Laps recorded as active/interval: 2 of 4.`);
    expect(text).toMatch(/verdict harder, work pace 4:22\/km vs target 4:30–4:40\/km, 102 % of planned time/);
    expect(text).toContain("Work pace 4:22/km was faster than the target");
    expect(text).toMatch(/Run \(measured\): .*10\.00 km.*avg HR 162.*decoupling 7\.2 %.*RPE 9\/10/);
    expect(text).toContain("HR drift 11 bpm");
    expect(text).toMatch(/Laps \(measured\):\n  1: 2\.50 km in 15:00/);
    expect(text).toMatch(/km 2: 4:28\/km, HR 170/);
    expect(text).toContain('Athlete\'s feedback: RPE 9/10, legs heavy, discomfort: "left achilles tight".');
    expect(text).toContain("CTL 41, ATL 53, TSB -12");
    // the 4 weeks up to the run, not what came after
    expect(text).toMatch(/Recent weeks \(calculated\):\n(  week of .*\n){3}  week of 2026-11-02 \(the run's week, up to the run\): 16 km, 87 min, 2 runs/);
    expect(text).not.toContain("2026-10-20");
  });

  it("says when there's no feedback and leaves out what wasn't recorded", async () => {
    const db = seed();
    db.tables.workout_feedback = [];
    db.tables.activity_laps = [];
    db.tables.fitness_state = [];
    const text = buildCheckinInput((await loadCheckinData(db as any, U, RUN))!);
    expect(text).toContain("Athlete's feedback: none yet.");
    expect(text).toContain("Planned work reps: 4.\n");
    expect(text).not.toMatch(/Laps|CTL/);
  });

  it("is only built for the athlete's own key sessions", async () => {
    const db = seed();
    expect(await loadCheckinData(db as any, U, EASY_RUN)).toBeNull();
    expect(await loadCheckinData(db as any, OTHER, RUN)).toBeNull();
    db.tables.planned_workouts = db.rows("planned_workouts").filter((w) => w.id !== W);
    expect(await loadCheckinData(db as any, U, RUN)).toBeNull();
  });

  it("hash changes with feedback and the matched workout, nothing else", () => {
    const fb = { rpe: 7, legs: "normal", discomfort: null, notes: null };
    expect(checkinHash(W, fb)).toBe(checkinHash(W, { ...fb, notes: "  " }));
    expect(checkinHash(W, fb)).not.toBe(checkinHash(W, { ...fb, rpe: 8 }));
    expect(checkinHash(W, fb)).not.toBe(checkinHash(W, { ...fb, discomfort: "calf" }));
    expect(checkinHash(W, fb)).not.toBe(checkinHash(W_EASY, fb));
    expect(checkinHash(W, null)).not.toBe(checkinHash(W, fb));
  });

  it("keeps the model's text to one short paragraph", () => {
    expect(checkinText({ output_text: "  Strong reps.\n\nKeep Saturday easy. " })).toBe("Strong reps. Keep Saturday easy.");
    expect(checkinText({ output: [{ type: "message", content: [{ type: "output_text", text: "From output." }] }] })).toBe("From output.");
    expect(checkinText({ output_text: "" })).toBeNull();
    expect(checkinText({ output_text: "x".repeat(600) })!.length).toBe(398);
  });
});

describe("check-in caching", () => {
  it("generates once, serves the cache, and regenerates when the feedback changes", async () => {
    const db = seed();
    const client = fakeClient(["Reps were quicker than planned at RPE 9 with a tight achilles; keep the next easy run truly easy.", "Good session at a manageable RPE 7; the plan stays as it is."]);
    const first = await getOrCreateCheckin(db as any, U, RUN, client as any);
    expect(first?.text).toMatch(/^Reps were quicker/);
    expect(client.requests).toHaveLength(1);
    const req = client.requests[0];
    expect(req.store).toBe(false);
    expect(req.instructions).toMatch(/one or two sentences/);
    expect(req.input).toBe(buildCheckinInput((await loadCheckinData(db as any, U, RUN))!));
    expect(db.rows("coach_checkins")).toHaveLength(1);
    expect(db.rows("coach_checkins")[0]).toMatchObject({ activity_id: RUN, user_id: U, workout_id: W, prompt_version: "checkin@1" });

    // cached: no second call, even without a client
    expect((await getOrCreateCheckin(db as any, U, RUN, client as any))?.text).toBe(first!.text);
    expect((await getOrCreateCheckin(db as any, U, RUN, null))?.text).toBe(first!.text);
    expect(client.requests).toHaveLength(1);

    // a new RPE makes the cached one stale
    db.rows("workout_feedback")[0].rpe = 7;
    db.rows("workout_feedback")[0].discomfort = null;
    expect(await getOrCreateCheckin(db as any, U, RUN, null)).toBeNull();
    const second = await getOrCreateCheckin(db as any, U, RUN, client as any);
    expect(second?.text).toMatch(/^Good session/);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].input).toContain("RPE 7/10");
    expect(db.rows("coach_checkins")).toHaveLength(1);
    expect(db.rows("coach_checkins")[0].text).toBe(second!.text);
  });

  it("does nothing for non-key runs, other athletes' runs, or when there's no API key", async () => {
    const db = seed();
    const client = fakeClient([]);
    expect(await getOrCreateCheckin(db as any, U, EASY_RUN, client as any)).toBeNull();
    expect(await getOrCreateCheckin(db as any, OTHER, RUN, client as any)).toBeNull();
    expect(await getOrCreateCheckin(db as any, U, RUN, null)).toBeNull();
    expect(client.responses.create).not.toHaveBeenCalled();
    expect(db.rows("coach_checkins")).toHaveLength(0);
  });

  it("stores nothing when the model returns no text", async () => {
    const db = seed();
    expect(await getOrCreateCheckin(db as any, U, RUN, fakeClient([" "]) as any)).toBeNull();
    expect(db.rows("coach_checkins")).toHaveLength(0);
  });

  it("gives the coach chat the run and its check-in for a follow-up", async () => {
    const db = seed();
    await getOrCreateCheckin(db as any, U, RUN, fakeClient(["Quick reps, watch that achilles."]) as any);
    const c = (await checkinContext(db as any, U, RUN))!;
    expect(c).toContain(`run on 2026-11-05 (run id ${RUN})`);
    expect(c).toContain('Your check-in on it, shown to them: "Quick reps, watch that achilles."');
    expect(c).toContain("Planned session:");
    expect(await checkinContext(db as any, OTHER, RUN)).toBeNull();
  });
});

describe("data deletion", () => {
  it("clears check-ins with training data (the delete function discovers every user_id table not kept)", () => {
    expect(KEEP_FOR_TRAINING).not.toContain("coach_checkins");
    expect(keepFor("everything")).toEqual([]);
  });
});

describe("follow-up in the coach chat", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test");
  const { runCoachTurn } = await import("@/lib/coach/service");
  it("sends the run context with the question but shows only the question", async () => {
    const db = seed();
    const requests: any[] = [];
    const client = {
      responses: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const output = [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ease off Saturday.", annotations: [] }] }];
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "response.output_text.delta", delta: "Ease off Saturday." };
            },
            finalResponse: async () => ({ id: "r1", model: params.model, status: "completed", output, usage: {} }),
          };
        },
      },
    };
    const context = (await checkinContext(db as any, U, RUN))!;
    for await (const e of runCoachTurn({ db: db as any, userId: U, conversationId: null, text: "Should I change Saturday?", today: "2026-11-06", timezone: "Europe/Oslo", context }, client as any)) void e;
    const user = requests[0].input.at(-1);
    expect(user.content.map((c: any) => c.text)).toEqual([expect.stringMatching(/^<athlete_data>/), `<run_context>\n${context}\n</run_context>`, "Should I change Saturday?"]);
    expect(db.rows("coach_messages").find((m) => m.kind === "user")!.display_text).toBe("Should I change Saturday?");
  });
});
