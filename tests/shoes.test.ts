/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveActivity } from "@/lib/analytics/summarize";
import { parseFitActivity } from "@/lib/fit/parse";
import { SupabaseIngestRepo } from "@/lib/ingest/supabase-repo";
import type { RawSourceRow } from "@/lib/ingest/types";
import { DEFAULT_RETIRE_M, defaultShoeFor, retireTarget, shoeMileage, shoesToReplace, wearState, type ShoeRow } from "@/lib/shoes/mileage";
import { defaultShoeIdFor, listShoesWithMileage, setDefaultShoe } from "@/lib/shoes/service";
import { FakeDb } from "./fake-db";
import { buildFit } from "./fit-builder";

const shoe = (over: Partial<ShoeRow> = {}): ShoeRow => ({
  id: "s1",
  name: "Pegasus",
  brand: null,
  model: null,
  starting_distance_m: 0,
  retire_at_distance_m: null,
  is_default: false,
  retired_at: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("shoe mileage", () => {
  it("adds previous km to linked runs and skips duplicates and other shoes", () => {
    const [s] = shoeMileage(
      [shoe({ starting_distance_m: 120_000 })],
      [
        { shoe_id: "s1", distance_m: 10_000 },
        { shoe_id: "s1", distance_m: 5_000, duplicate_of: "a0" },
        { shoe_id: "s2", distance_m: 8_000 },
        { shoe_id: null, distance_m: 7_000 },
        { shoe_id: "s1", distance_m: null },
      ],
    );
    expect(s.totalM).toBe(130_000);
    expect(s.runs).toBe(2);
    expect(s.retireAtM).toBe(DEFAULT_RETIRE_M);
    expect(s.state).toBe("ok");
  });

  it("uses the athlete's retire distance when set", () => {
    expect(retireTarget({ retire_at_distance_m: 500_000 })).toBe(500_000);
    expect(retireTarget({ retire_at_distance_m: null })).toBe(700_000);
    expect(retireTarget({ retire_at_distance_m: 0 })).toBe(700_000);
  });

  it("flags shoes at 90 % and at the retire distance", () => {
    expect(wearState(629_999, 700_000)).toBe("ok");
    expect(wearState(630_000, 700_000)).toBe("near");
    expect(wearState(700_000, 700_000)).toBe("due");
    expect(wearState(900_000, 700_000)).toBe("due");
  });

  it("nudges only active shoes, most worn first", () => {
    const list = shoeMileage(
      [
        shoe({ id: "a", starting_distance_m: 650_000 }),
        shoe({ id: "b", starting_distance_m: 720_000 }),
        shoe({ id: "c", starting_distance_m: 800_000, retired_at: "2026-10-10T00:00:00Z" }),
        shoe({ id: "d", starting_distance_m: 100_000 }),
      ],
      [],
    );
    expect(shoesToReplace(list).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("default shoe", () => {
  const start = new Date("2026-11-01T07:00:00Z");

  it("picks the active default for runs after the shoe was added", () => {
    expect(defaultShoeFor([shoe(), shoe({ id: "s2", is_default: true })], start)).toBe("s2");
  });

  it("does not backfill runs from before the shoe was added", () => {
    expect(defaultShoeFor([shoe({ is_default: true, created_at: "2026-11-02T00:00:00Z" })], start)).toBeNull();
  });

  it("ignores a retired default and having no default", () => {
    expect(defaultShoeFor([shoe({ is_default: true, retired_at: "2026-10-20T00:00:00Z" })], start)).toBeNull();
    expect(defaultShoeFor([shoe()], start)).toBeNull();
  });

  it("keeps one default per athlete", async () => {
    const db = new FakeDb({
      shoes: [
        { ...shoe({ id: "a", is_default: true }), user_id: "u1" },
        { ...shoe({ id: "b" }), user_id: "u1" },
        { ...shoe({ id: "x", is_default: true }), user_id: "u2" },
      ],
    });
    await setDefaultShoe(db as unknown as SupabaseClient, "u1", "b");
    expect(db.rows("shoes").filter((s) => s.is_default).map((s) => s.id).sort()).toEqual(["b", "x"]);
    await setDefaultShoe(db as unknown as SupabaseClient, "u1", null);
    expect(db.rows("shoes").filter((s) => s.is_default).map((s) => s.id)).toEqual(["x"]);
  });

  it("returns null instead of failing the import when shoes cannot be read", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "no such table" } }) }) }) }) }) };
    expect(await defaultShoeIdFor(broken as unknown as SupabaseClient, "u1", start)).toBeNull();
  });

  it("totals a shoe from the database", async () => {
    const db = new FakeDb({
      shoes: [{ ...shoe({ starting_distance_m: 50_000 }), user_id: "u1" }],
      activities: [
        { id: "a1", user_id: "u1", shoe_id: "s1", distance_m: 10_000, duplicate_of: null },
        { id: "a2", user_id: "u1", shoe_id: "s1", distance_m: 10_000, duplicate_of: "a1" },
        { id: "a3", user_id: "u2", shoe_id: "s1", distance_m: 10_000, duplicate_of: null },
      ],
    });
    const [s] = await listShoesWithMileage(db as unknown as SupabaseClient, "u1");
    expect(s.totalM).toBe(60_000);
  });
});

/** FakeDb whose activities upsert returns the saved row, as PostgREST does with .select().single(). */
function ingestDb(fake: FakeDb): SupabaseClient {
  return {
    from(t: string) {
      const q = fake.from(t) as any;
      if (t !== "activities") return q;
      const upsert = q.upsert.bind(q);
      q.upsert = (row: any, o: any) => {
        const pending = upsert(row, o);
        return {
          select: () => ({
            single: async () => {
              await pending;
              return { data: fake.rows("activities").find((r) => r.raw_source_id === row.raw_source_id), error: null };
            },
          }),
        };
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("shoe on ingest", () => {
  const runStart = new Date("2026-11-03T06:00:00Z");
  const activity = parseFitActivity(buildFit({ start: runStart, segments: [{ durationS: 600, speedMs: 3, hr: 140 }] }));
  const derived = deriveActivity(activity);
  const raw: RawSourceRow = {
    id: "raw-1",
    externalId: "1",
    activityType: "running",
    startTime: runStart,
    name: "Morning run",
    status: "downloaded",
    attempts: 0,
    filePath: "garmin/1/x.fit",
    syncJobId: null,
  };

  it("gives a new run the default shoe and never overwrites the shoe on reprocess", async () => {
    const fake = new FakeDb({
      shoes: [
        { ...shoe({ id: "def", is_default: true }), user_id: "u1" },
        { ...shoe({ id: "other" }), user_id: "u1" },
      ],
    });
    const repo = new SupabaseIngestRepo(ingestDb(fake), "u1");
    await repo.saveActivity(raw, activity, derived);
    const [saved] = fake.rows("activities");
    expect(saved.shoe_id).toBe("def");

    // the athlete picks another shoe, then the run is reprocessed
    saved.shoe_id = "other";
    await repo.saveActivity(raw, activity, derived);
    expect(fake.rows("activities")).toHaveLength(1);
    expect(fake.rows("activities")[0].shoe_id).toBe("other");

    // clearing it by hand also survives
    saved.shoe_id = null;
    await repo.saveActivity(raw, activity, derived);
    expect(fake.rows("activities")[0].shoe_id).toBeNull();
  });

  it("leaves the run unassigned without a default", async () => {
    const fake = new FakeDb({ shoes: [{ ...shoe(), user_id: "u1" }] });
    await new SupabaseIngestRepo(ingestDb(fake), "u1").saveActivity(raw, activity, derived);
    expect(fake.rows("activities")[0].shoe_id ?? null).toBeNull();
  });
});
