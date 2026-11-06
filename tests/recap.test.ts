/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

vi.mock("server-only", () => ({}));
const { buildWeekRecap, compareEstimates, snapshotFromHistory, snapshotFromModel, formatChangeDelta } = await import("../src/lib/recap/build");
const { ensureWeeklyRecap, markRecapSeen, reviewedWeek } = await import("../src/lib/recap/service");

const model = (vdot: number, ctl: number, extra: Record<string, any> = {}) => ({
  asOf: "2026-11-09",
  estimate: { withheld: false, vdot, lower: vdot - 1, upper: vdot + 1, confidence: "medium" },
  predictions: [
    { key: "5k", label: "5 km", distanceM: 5000, timeS: 1500 - (vdot - 40) * 30, fastS: 1450, slowS: 1550 },
    { key: "10k", label: "10 km", distanceM: 10_000, timeS: 3100 - (vdot - 40) * 60, fastS: 3000, slowS: 3200 },
  ],
  threshold: { paceSPerKm: 300 - (vdot - 40) * 3, hr: 170 },
  load: [{ date: "2026-11-08", ctl, atl: ctl + 5, tsb: -5 }],
  rampRate: 2,
  efficiency: { changePer30dPct: 1.5 },
  physiology: { restHr: { value: 52 }, maxHr: { value: 190 } },
  longestRecentM: 10_000,
  ...extra,
});

describe("estimate snapshots", () => {
  it("freezes the model output", () => {
    const s = snapshotFromModel(model(42, 30), "fitness@1", null);
    expect(s.vdot?.value).toBe(42);
    expect(s.predictions).toHaveLength(2);
    expect(s.thresholdPaceS).toBe(294);
    expect(s.ctl).toBe(30);
    expect(s.restHr).toBe(52);
    expect(s.source).toBe("model");
  });

  it("has no VDOT when the estimate is withheld", () => {
    const s = snapshotFromModel({ estimate: { withheld: true, reason: "x" }, predictions: null, load: [] }, "fitness@1", null);
    expect(s.vdot).toBeNull();
    expect(s.predictions).toEqual([]);
    expect(s.ctl).toBeNull();
  });

  it("rebuilds a snapshot from the weekly model history", () => {
    const s = snapshotFromHistory(
      [
        { metric: "vdot", value: 41, lower_bound: 40, upper_bound: 42, confidence: "low" },
        { metric: "race_10k", value: 3160, lower_bound: 3100, upper_bound: 3220, confidence: "low" },
        { metric: "ctl", value: 28, lower_bound: null, upper_bound: null, confidence: null },
      ],
      "2026-11-01",
      "fitness@1",
    )!;
    expect(s.vdot?.value).toBe(41);
    expect(s.predictions.map((p) => p.key)).toEqual(["10k"]);
    expect(s.ctl).toBe(28);
    expect(snapshotFromHistory([], "2026-11-01", null)).toBeNull();
  });
});

describe("compareEstimates", () => {
  it("marks faster times and higher VDOT as better, and ignores noise", () => {
    const race = { name: "Oslo 10k", distanceM: 10_000, raceDate: "2027-04-24", targetTimeS: 2700, fastS: null, slowS: null, verdict: null };
    const prev = snapshotFromModel(model(41, 28), "fitness@1", { ...race, predictedS: 3160, projectedS: 2900 });
    const cur = snapshotFromModel(model(42, 28.2), "fitness@1", { ...race, predictedS: 3100, projectedS: 2930 });
    const ch = compareEstimates(prev, cur);
    const by = (k: string) => ch.find((c) => c.key === k)!;
    expect(by("vdot").direction).toBe("better");
    expect(by("race_goal").direction).toBe("better");
    expect(by("race_goal").delta).toBe(-60);
    expect(by("race_projection").direction).toBe("worse");
    // the goal distance isn't listed twice
    expect(ch.find((c) => c.key === "race_10k")).toBeUndefined();
    expect(by("race_5k").direction).toBe("better");
    expect(by("threshold_pace").direction).toBe("better");
    expect(by("ctl").direction).toBe("same");
    expect(formatChangeDelta(by("race_goal"))).toBe("−1:00");
  });

  it("returns nothing without an earlier snapshot", () => {
    expect(compareEstimates(null, snapshotFromModel(model(42, 30), null, null))).toEqual([]);
  });

  it("flags a drop in fitness", () => {
    const ch = compareEstimates(snapshotFromModel(model(43, 30), null, null), snapshotFromModel(model(42, 26), null, null));
    expect(ch.find((c) => c.key === "vdot")!.direction).toBe("worse");
    expect(ch.find((c) => c.key === "ctl")!.direction).toBe("worse");
  });
});

const WEEK = "2026-11-02";
const planWeeks = [
  { index: 0, start: "2026-10-26", phase: "base", targetMinutes: 110, note: "" },
  { index: 1, start: WEEK, phase: "base", targetMinutes: 120, note: "" },
  { index: 2, start: "2026-11-09", phase: "build", targetMinutes: 135, note: "" },
] as any[];

function history() {
  const runs = [];
  // four steady weeks before: 3 × 40 min, 7 km
  for (let w = 1; w <= 4; w++) for (const d of [0, 2, 5]) runs.push({ date: addDays(WEEK, -7 * w + d), movingS: 2400, distanceM: 7000 });
  return runs;
}
function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

describe("buildWeekRecap", () => {
  it("compares planned with done and describes the next week", () => {
    const r = buildWeekRecap({
      weekStart: WEEK,
      runs: [...history(), { date: "2026-11-03", movingS: 2400, distanceM: 7000 }, { date: "2026-11-08", movingS: 3600, distanceM: 10_000 }],
      planWeeks,
      workouts: [
        { date: "2026-11-03", type: "easy", title: "Easy run", status: "completed", key: false, durationS: 2400, actualS: 2400 },
        { date: "2026-11-05", type: "threshold", title: "Threshold", status: "missed", key: true, durationS: 2700 },
        { date: "2026-11-08", type: "long", title: "Long run", status: "completed", key: true, durationS: 3600, actualS: 3600 },
        { date: "2026-11-07", type: "rest", title: "Rest", status: "planned", key: false, durationS: 0 },
      ],
      nextWorkouts: [
        { date: "2026-11-10", type: "easy", title: "Easy", status: "planned", key: false, durationS: 2400 },
        { date: "2026-11-15", type: "long", title: "Long", status: "planned", key: true, durationS: 4200 },
      ],
      versions: [
        { version: 1, reason: "Plan created", createdBy: "generator", createdAt: "2026-10-20T10:00:00Z" },
        { version: 4, reason: "Weekly update: the coming weeks were recalculated", createdBy: "adaptation", createdAt: "2026-11-09T00:10:00Z" },
      ],
      current: snapshotFromModel(model(42, 30), null, null),
      previous: snapshotFromModel(model(41.5, 29), null, null),
      comparedWith: { weekStart: "2026-10-26", asOf: "2026-11-02", source: "recap" },
    });
    expect(r.weekEnd).toBe("2026-11-08");
    expect(r.volume).toEqual({ runs: 2, minutes: 100, km: 17, longestKm: 10 });
    expect(r.typical).toEqual({ runs: 3, minutes: 120, km: 21 });
    expect(r.plan!.total).toBe(3);
    expect(r.plan!.done).toBe(2);
    expect(r.plan!.keyDone).toBe(1);
    expect(r.plan!.keyTotal).toBe(2);
    expect(r.headline).toBe("2 of 3 planned runs done");
    expect(r.next).toMatchObject({ targetMinutes: 135, sessions: 2, longestMin: 70, changeMinutes: 15, phase: "build" });
    // only changes from the reviewed week on
    expect(r.adjustments).toHaveLength(1);
    expect(r.points.some((p) => p.includes("recalculated"))).toBe(true);
    expect(r.points.some((p) => p.includes("rose from 41.5 to 42.0"))).toBe(true);
    expect(r.weeklyKm).toHaveLength(8);
    expect(r.weeklyKm.at(-1)).toEqual({ weekStart: WEEK, km: 17 });
    expect(r.caution).toBeNull();
  });

  it("flags a big jump in volume", () => {
    const r = buildWeekRecap({
      weekStart: WEEK,
      runs: [...history(), { date: "2026-11-03", movingS: 4800, distanceM: 13_000 }, { date: "2026-11-06", movingS: 4800, distanceM: 13_000 }],
      planWeeks: null,
      workouts: [],
      nextWorkouts: [],
      versions: [],
      current: snapshotFromModel(model(42, 30), null, null),
      previous: null,
      comparedWith: null,
    });
    expect(r.plan).toBeNull();
    expect(r.caution).toMatch(/33 % above your 4-week average/);
    expect(r.headline).toBe("2 runs, 26 km");
    expect(r.changes).toEqual([]);
  });

  it("handles a week off", () => {
    const r = buildWeekRecap({
      weekStart: WEEK,
      runs: history(),
      planWeeks: null,
      workouts: [],
      nextWorkouts: [],
      versions: [],
      current: snapshotFromModel(null, null, null),
      previous: null,
      comparedWith: null,
    });
    expect(r.headline).toBe("A week off");
    expect(r.volume.runs).toBe(0);
  });
});

describe("ensureWeeklyRecap", () => {
  function seed() {
    return new FakeDb({
      goals: [{ id: "g", user_id: "u", kind: "10k", name: "Oslo 10k", distance_m: 10_000, race_date: "2027-04-24", target_time_s: 2700 }],
      training_plans: [{ id: "p", user_id: "u", goal_id: "g", status: "active", weeks: planWeeks, config: { refreshedWeek: "2026-11-09" }, baseline: {} }],
      planned_workouts: [
        { id: "w1", plan_id: "p", user_id: "u", date: "2026-11-03", type: "easy", title: "Easy run", status: "completed", key: false, duration_s: 2400, activity_id: "a1" },
        { id: "w2", plan_id: "p", user_id: "u", date: "2026-11-10", type: "easy", title: "Easy run", status: "planned", key: false, duration_s: 2400, activity_id: null },
      ],
      plan_versions: [],
      activities: [
        { id: "a1", user_id: "u", local_date: "2026-11-03", sport: "running", moving_s: 2400, distance_m: 7000, duplicate_of: null },
        { id: "a0", user_id: "u", local_date: "2026-10-28", sport: "running", moving_s: 2400, distance_m: 7000, duplicate_of: null },
        { id: "x", user_id: "other", local_date: "2026-11-04", sport: "running", moving_s: 9999, distance_m: 30000, duplicate_of: null },
      ],
      fitness_state: [{ user_id: "u", model_version: "fitness@1", as_of: "2026-11-09", output: model(42, 30) }],
      fitness_snapshots: [
        { user_id: "u", kind: "retrospective", model_version: "fitness@1", as_of: "2026-11-01", metric: "vdot", value: 41, lower_bound: 40, upper_bound: 42, confidence: "low" },
        { user_id: "u", kind: "retrospective", model_version: "fitness@1", as_of: "2026-11-01", metric: "race_10k", value: 3200, lower_bound: null, upper_bound: null, confidence: "low" },
      ],
      weekly_recaps: [],
    });
  }

  it("reviews the last finished week once, and compares with the model history the first time", async () => {
    const db = seed();
    expect(reviewedWeek("2026-11-12")).toBe(WEEK);
    const row = (await ensureWeeklyRecap(db as any, "u", "2026-11-09"))!;
    expect(row.week_start).toBe(WEEK);
    expect(row.seen_at ?? null).toBeNull();
    expect(row.recap.volume.runs).toBe(1); // the other user's run doesn't count
    expect(row.recap.plan!.done).toBe(1);
    expect(row.estimates.race!.name).toBe("Oslo 10k");
    expect(row.estimates.race!.predictedS).toBeGreaterThan(0);
    expect(row.recap.comparedWith!.source).toBe("history");
    expect(row.recap.changes.find((c) => c.key === "vdot")!.before).toBe(41);
    expect(row.recap.changes.find((c) => c.key === "race_goal")!.before).toBe(3200);

    // a second call returns the same row
    const again = (await ensureWeeklyRecap(db as any, "u", "2026-11-11"))!;
    expect(again.id).toBe(row.id);
    expect(db.rows("weekly_recaps")).toHaveLength(1);

    await markRecapSeen(db as any, "u", WEEK);
    expect(db.rows("weekly_recaps")[0].seen_at).toBeTruthy();
  });

  it("compares the next week with the stored snapshot", async () => {
    const db = seed();
    await ensureWeeklyRecap(db as any, "u", "2026-11-09");
    db.rows("fitness_state")[0].output = model(43, 31);
    const next = (await ensureWeeklyRecap(db as any, "u", "2026-11-16"))!;
    expect(next.week_start).toBe("2026-11-09");
    expect(next.recap.comparedWith).toMatchObject({ source: "recap", weekStart: WEEK });
    const v = next.recap.changes.find((c) => c.key === "vdot")!;
    expect(v.before).toBe(42);
    expect(v.after).toBe(43);
  });

  it("makes nothing for an account with no runs and no plan", async () => {
    const db = new FakeDb({ training_plans: [], activities: [], weekly_recaps: [] });
    expect(await ensureWeeklyRecap(db as any, "u", "2026-11-09")).toBeNull();
    expect(db.rows("weekly_recaps")).toHaveLength(0);
  });
});
