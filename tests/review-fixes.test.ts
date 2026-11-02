import { describe, expect, it } from "vitest";
import { fetchAll } from "@/lib/db/paginate";
import { weeklyVolume } from "@/lib/analytics/volume";
import { syncWellness } from "@/lib/ingest/wellness";
import { MemoryIngestRepo } from "@/lib/ingest/memory-repo";
import { GarminAuthError, GarminPersonalApiClient, GARMIN_TOKEN_URL } from "@/lib/integrations/garmin/client";
import { isValidTimeZone } from "@/lib/tz";

describe("fetchAll", () => {
  it("pages past the 1000-row PostgREST limit", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => i);
    const calls: [number, number][] = [];
    const out = await fetchAll(async (from, to) => {
      calls.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(out).toHaveLength(2345);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("throws instead of returning a partial result", async () => {
    await expect(fetchAll(async () => ({ data: null, error: { message: "boom" } }))).rejects.toThrow(/boom/);
  });
});

describe("weeklyVolume", () => {
  it("counts runs only, not walks that slipped into the activity table", () => {
    const w = weeklyVolume(
      [
        { local_date: "2026-10-26", distance_m: 10000, moving_s: 3000, sport: "running" },
        { local_date: "2026-10-27", distance_m: 4000, moving_s: 2400, sport: "walking" },
      ],
      "2026-10-26",
      "2026-11-01",
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ distanceM: 10000, runs: 1 });
  });
});

describe("syncWellness", () => {
  const client = (onCall: () => void) =>
    ({
      dailySummaries: async () => (onCall(), []),
      sleepSummaries: async () => [],
      hrvDaily: async () => [],
      stressDaily: async () => [],
      bodyBatteryDaily: async () => [],
    }) as unknown as GarminPersonalApiClient;

  it("completes within the deadline, and reports where to resume when it runs out", async () => {
    let calls = 0;
    const c = client(() => {
      calls++;
    });
    const full = await syncWellness(c, new MemoryIngestRepo(), "2026-01-01", "2026-03-31", Date.now() + 10_000);
    expect(full.resumeFrom).toBeNull();
    expect(calls).toBe(4); // 90 days = four 28-day chunks
    const partial = await syncWellness(c, new MemoryIngestRepo(), "2026-01-01", "2026-03-31", Date.now() - 1);
    expect(partial.resumeFrom).toBe("2026-01-01");
  });

  it("propagates auth errors instead of recording them as wellness gaps", async () => {
    const c = {
      ...client(() => {}),
      dailySummaries: async () => {
        throw new GarminAuthError("nope", 401);
      },
    } as unknown as GarminPersonalApiClient;
    await expect(syncWellness(c, new MemoryIngestRepo(), "2026-01-01", "2026-01-10")).rejects.toBeInstanceOf(GarminAuthError);
  });
});

describe("Garmin client deadline", () => {
  it("does not sleep through a long Retry-After past the deadline", async () => {
    const slept: number[] = [];
    const f = (async (url: RequestInfo | URL) => {
      if (String(url) === GARMIN_TOKEN_URL) return new Response("tok", { status: 200 });
      return new Response("busy", { status: 429, headers: { "retry-after": "50" } });
    }) as typeof fetch;
    const c = new GarminPersonalApiClient({
      apiKey: "k",
      tokenStore: { load: async () => null, save: async () => {}, clear: async () => {} },
      fetchImpl: f,
      sleep: async (ms) => {
        slept.push(ms);
      },
      minIntervalMs: 0,
      deadline: Date.now() + 5_000,
    });
    await expect(c.listActivities({ start: 0, limit: 1 })).rejects.toThrow(/HTTP 429/);
    expect(slept.every((ms) => ms < 5_000)).toBe(true);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Asia/Ho_Chi_Minh")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("splits", () => {
  it("does not mark the first km partial when the first sample is past 0 m", async () => {
    const { buildFit } = await import("./fit-builder");
    const { parseFitActivity } = await import("@/lib/fit/parse");
    const { deriveActivity } = await import("@/lib/analytics/summarize");
    const d = deriveActivity(parseFitActivity(buildFit({ segments: [{ durationS: 1200, speedMs: 3, hr: 140 }] })));
    expect(d.splits[0].partial).toBe(false);
    expect(d.splits.filter((s) => s.partial).length).toBeLessThanOrEqual(1);
    expect(d.splits.slice(0, -1).every((s) => !s.partial)).toBe(true);
  });
});
