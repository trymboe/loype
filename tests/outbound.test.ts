/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planOutbound, type OutboundWorkout, type SyncRow } from "../src/lib/outbound/plan";
import { IntervalsAuthError, IntervalsClient } from "../src/lib/integrations/intervals/client";
import { encryptSecret } from "../src/lib/crypto/secretbox";
import { confirmOnWatch, pushPlannedWorkouts } from "../src/lib/outbound/service";
import type { Step } from "../src/lib/planning/types";

const tgt = { zone: "easy" as const, paceFast: 330, paceSlow: 370, hrMin: 125, hrMax: 145, label: "Easy" };
const steps: Step[] = [{ kind: "run", durationS: 2400, target: tgt }];
const athlete = { hasThresholdPace: true, maxHr: 190 };
const W = (id: string, date: string, extra: Partial<OutboundWorkout> = {}): OutboundWorkout => ({ id, date, type: "easy", title: "Easy run", objective: "", steps, duration_s: 2400, status: "planned", active: true, ...extra });

describe("planOutbound", () => {
  const today = "2026-11-02";
  it("sends upcoming workouts inside the window only, skipping rest/skipped/past", () => {
    const p = planOutbound({
      today,
      workouts: [W("a", "2026-11-02"), W("b", "2026-11-15"), W("c", "2026-11-16"), W("d", "2026-11-04", { type: "rest", steps: [] }), W("e", "2026-11-05", { status: "skipped" }), W("f", "2026-11-01")],
      rows: [],
      athlete,
    });
    expect(p.upserts.map((u) => u.workout.id)).toEqual(["a", "b"]);
    expect(p.deletes).toEqual([]);
  });

  it("doesn't resend unchanged workouts, resends changed or failed ones", () => {
    const first = planOutbound({ today, workouts: [W("a", "2026-11-03")], rows: [], athlete });
    const hash = first.upserts[0].hash;
    const row = (state: string, h = hash): SyncRow => ({ id: "r", planned_workout_id: "a", external_id: "loype-a", workout_date: "2026-11-03", payload_hash: h, state });
    expect(planOutbound({ today, workouts: [W("a", "2026-11-03")], rows: [row("parsed")], athlete }).unchanged).toBe(1);
    expect(planOutbound({ today, workouts: [W("a", "2026-11-03")], rows: [row("on_watch")], athlete }).upserts).toHaveLength(0);
    expect(planOutbound({ today, workouts: [W("a", "2026-11-03")], rows: [row("failed")], athlete }).upserts).toHaveLength(1);
    expect(planOutbound({ today, workouts: [W("a", "2026-11-04")], rows: [row("parsed")], athlete }).upserts).toHaveLength(1);
    expect(planOutbound({ today, workouts: [W("a", "2026-11-03")], rows: [row("parsed")], athlete, force: true }).upserts).toHaveLength(1);
  });

  it("keeps a sent workout in sync when it moves beyond the window", () => {
    const row: SyncRow = { id: "r", planned_workout_id: "a", external_id: "loype-a", workout_date: "2026-11-10", payload_hash: "x", state: "parsed" };
    const p = planOutbound({ today, workouts: [W("a", "2026-11-30")], rows: [row], athlete });
    expect(p.upserts.map((u) => u.workout.date)).toEqual(["2026-11-30"]);
    expect(p.deletes).toEqual([]);
  });

  it("removes upcoming remote copies of deleted, skipped, rested or archived-plan workouts, but never past ones", () => {
    const rows: SyncRow[] = [
      { id: "1", planned_workout_id: null, external_id: "loype-x", workout_date: "2026-11-05", payload_hash: "h", state: "parsed" },
      { id: "2", planned_workout_id: "s", external_id: "loype-s", workout_date: "2026-11-05", payload_hash: "h", state: "parsed" },
      { id: "3", planned_workout_id: "r", external_id: "loype-r", workout_date: "2026-11-06", payload_hash: "h", state: "on_watch" },
      { id: "4", planned_workout_id: "o", external_id: "loype-o", workout_date: "2026-11-07", payload_hash: "h", state: "parsed" },
      { id: "5", planned_workout_id: null, external_id: "loype-p", workout_date: "2026-10-30", payload_hash: "h", state: "parsed" },
      { id: "6", planned_workout_id: null, external_id: "loype-q", workout_date: "2026-11-08", payload_hash: "h", state: "removed" },
    ];
    const p = planOutbound({
      today,
      workouts: [W("s", "2026-11-05", { status: "skipped" }), W("r", "2026-11-06", { type: "rest", steps: [] }), W("o", "2026-11-07", { active: false })],
      rows,
      athlete,
    });
    expect(p.deletes.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("IntervalsClient", () => {
  it("uses Basic API_KEY auth, athlete 0 and the bulk upsert endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: 7, external_id: "loype-a" }]), { status: 200 }));
    const c = new IntervalsClient({ apiKey: "secret", fetchImpl: fetchImpl as any });
    const out = await c.upsertEvents([{ external_id: "loype-a" } as any]);
    expect(out[0].id).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://intervals.icu/api/v1/athlete/0/events/bulk?upsert=true");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("API_KEY:secret").toString("base64")}`);
    expect(JSON.parse(init.body)).toEqual([{ external_id: "loype-a" }]);
  });

  it("deletes by external id and maps 401 to an auth error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    await new IntervalsClient({ apiKey: "k", athleteId: "i42", fetchImpl: fetchImpl as any }).deleteEvents(["loype-a"]);
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe("https://intervals.icu/api/v1/athlete/i42/events/bulk-delete");
    expect(JSON.parse((fetchImpl.mock.calls[0] as any[])[1].body)).toEqual([{ external_id: "loype-a" }]);
    const denied = new IntervalsClient({ apiKey: "k", fetchImpl: (async () => new Response("no", { status: 401 })) as any });
    await expect(denied.getAthlete()).rejects.toBeInstanceOf(IntervalsAuthError);
  });
});

/* ---------- pushPlannedWorkouts against a tiny in-memory Supabase ---------- */

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: string; payload?: any; onConflict?: string } = { kind: "select" };
    let single = false;
    const rows = () => (tables[table] ??= []);
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => (filters.push((r) => r[k] === v), q),
      neq: (k: string, v: any) => (filters.push((r) => r[k] !== v), q),
      gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), q),
      in: (k: string, vs: any[]) => (filters.push((r) => vs.includes(r[k])), q),
      order: () => q,
      range: () => q,
      limit: () => q,
      maybeSingle: () => ((single = true), q),
      update: (p: any) => ((op = { kind: "update", payload: p }), q),
      insert: (p: any) => ((op = { kind: "insert", payload: p }), q),
      upsert: (p: any, o: any) => ((op = { kind: "upsert", payload: p, onConflict: o.onConflict }), q),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    const run = () => {
      const match = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") match.forEach((r) => Object.assign(r, op.payload));
      if (op.kind === "insert") rows().push({ id: `id${++seq}`, ...op.payload });
      if (op.kind === "upsert") {
        const keys = op.onConflict!.split(",");
        const hit = rows().find((r) => keys.every((k) => r[k] === op.payload[k]));
        if (hit) Object.assign(hit, op.payload);
        else rows().push({ id: `id${++seq}`, ...op.payload });
      }
      return { data: single ? (match[0] ?? null) : match, error: null };
    };
    return q;
  };
  return { from } as any;
}

describe("IntervalsClient.setRunThresholds", () => {
  it("PUTs threshold pace in m/s to the Run settings group, and LTHR only when missing", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/athlete/0")) return new Response(JSON.stringify({ id: "i1", sportSettings: [{ id: 42, types: ["Run"], max_hr: 193 }] }));
      return new Response("{}");
    };
    await new IntervalsClient({ apiKey: "k", fetchImpl: fetchImpl as any }).setRunThresholds(300, 175);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://intervals.icu/api/v1/athlete/0/sport-settings/42");
    expect(put.body).toEqual({ threshold_pace: 3.3333, lthr: 175 });
  });
});

describe("pushPlannedWorkouts", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });

  function setup() {
    const tables: Record<string, Row[]> = {
      integrations: [{ id: "i1", user_id: "u", provider: "intervals_icu", status: "connected", api_key_ciphertext: encryptSecret("k"), settings: {} }],
      training_plans: [{ id: "p", user_id: "u", status: "active" }],
      planned_workouts: [
        { id: "w1", plan_id: "p", user_id: "u", date: "2026-11-03", type: "easy", title: "Easy run", objective: "", steps, duration_s: 2400, status: "planned" },
        { id: "w2", plan_id: "p", user_id: "u", date: "2026-11-04", type: "rest", title: "Rest", objective: "", steps: [], duration_s: 0, status: "planned" },
      ],
      external_workout_syncs: [],
    };
    const calls: { url: string; body: any }[] = [];
    let parse = true;
    const fetchImpl = async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url.endsWith("/athlete/0")) return new Response(JSON.stringify({ id: "i1", name: "Trym", sportSettings: [{ types: ["Run"], threshold_pace: 3.5, max_hr: 190 }] }));
      if (url.includes("bulk?upsert")) return new Response(JSON.stringify(body.map((e: any, i: number) => ({ id: 100 + i, external_id: e.external_id, workout_doc: parse ? { steps: [{ duration: 2400, pace: { start: 330, end: 370 } }] } : { steps: [{ duration: 2400 }] } }))));
      return new Response("1");
    };
    return { db: fakeDb(tables), tables, calls, fetchImpl: fetchImpl as any, setParse: (v: boolean) => (parse = v) };
  }

  it("sends, verifies the parse, then does nothing when the plan hasn't changed", async () => {
    const s = setup();
    const r1 = await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(r1).toMatchObject({ configured: true, sent: 1, failed: 0 });
    expect(s.tables.external_workout_syncs).toHaveLength(1);
    expect(s.tables.external_workout_syncs[0]).toMatchObject({ planned_workout_id: "w1", external_id: "loype-w1", state: "parsed", remote_id: "100", target_mode: "PACE" });
    const upsert = s.calls.find((c) => c.url.includes("bulk?upsert"))!;
    expect(upsert.body[0].description).toBe("- Easy 40m 5:30-6:10/km Pace");

    const before = s.calls.length;
    const r2 = await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(r2).toMatchObject({ sent: 0, unchanged: 1 });
    expect(s.calls.length).toBe(before); // no API calls at all
  });

  it("deletes and re-creates a changed workout so Intervals.icu re-exports it to Garmin", async () => {
    const s = setup();
    await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    const first = s.calls.length;
    s.tables.planned_workouts[0].date = "2026-11-05";
    const r = await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(r.sent).toBe(1);
    const later = s.calls.slice(first).map((c) => c.url.split("/events/")[1]);
    expect(later).toEqual(["bulk-delete", "bulk?upsert=true"]);
    expect(s.calls.slice(first)[0].body).toEqual([{ external_id: "loype-w1" }]);
  });

  it("flags a parse mismatch instead of claiming success", async () => {
    const s = setup();
    s.setParse(false);
    await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(s.tables.external_workout_syncs[0].state).toBe("mismatch");
    expect(s.tables.external_workout_syncs[0].parse_check.problems[0]).toMatch(/0 of 1 targets/);
  });

  it("removes the remote copy when a workout is skipped, and only the athlete can mark it on the watch", async () => {
    const s = setup();
    await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(await confirmOnWatch(s.db, "u", "w1", true)).toBe(true);
    expect(s.tables.external_workout_syncs[0].state).toBe("on_watch");
    s.tables.planned_workouts[0].status = "skipped";
    const r = await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl });
    expect(r.removed).toBe(1);
    expect(s.calls.at(-1)!.url).toContain("bulk-delete");
    expect(s.tables.external_workout_syncs[0].state).toBe("removed");
    expect(await confirmOnWatch(s.db, "u", "w1", true)).toBe(false);
  });

  it("records a rejected key without throwing, and is a no-op when not connected", async () => {
    const s = setup();
    const res = await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: (async () => new Response("", { status: 401 })) as any });
    expect(res).toMatchObject({ authError: true });
    expect(s.tables.integrations[0].status).toBe("needs_reauth");
    s.tables.integrations[0].status = "not_configured";
    expect((await pushPlannedWorkouts(s.db, "u", "2026-11-02", { fetchImpl: s.fetchImpl })).configured).toBe(false);
  });
});
