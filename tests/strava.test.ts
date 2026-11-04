import { describe, expect, it, vi } from "vitest";
import { runSyncTick, startHistoricalImport } from "@/lib/ingest/engine";
import { MemoryIngestRepo } from "@/lib/ingest/memory-repo";
import { deriveActivity } from "@/lib/analytics/summarize";
import {
  StravaAuthError,
  StravaClient,
  StravaNotFoundError,
  StravaRateLimitError,
  type StravaStreams,
  type StravaSummaryActivity,
  type StravaTokens,
} from "@/lib/integrations/strava/client";
import { decodeBundle, encodeBundle, normalizeStrava, StravaParseError } from "@/lib/integrations/strava/normalize";
import { stravaSource, type StravaLike } from "@/lib/integrations/strava/source";

vi.mock("server-only", () => ({}));
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { signState, verifyState } = await import("@/lib/ingest/strava-service");

/** A 20-minute Apple Watch run at 3 m/s, 1 Hz, with a 60 s pause after 10 minutes. */
function appleWatchRun(id = 1, start = "2026-11-03T06:00:00Z") {
  const time: number[] = [];
  const dist: number[] = [];
  const latlng: [number, number][] = [];
  let d = 0;
  for (let t = 0; t <= 1260; t++) {
    if (t > 600 && t < 660) continue; // paused: no samples
    if (t >= 660 || t <= 600) d = t <= 600 ? t * 3 : 600 * 3 + (t - 660) * 3;
    time.push(t);
    dist.push(d);
    latlng.push([59.9 + d / 111_000, 10.7]);
  }
  const n = time.length;
  const streams: StravaStreams = {
    time: { data: time },
    distance: { data: dist },
    latlng: { data: latlng },
    altitude: { data: new Array(n).fill(20) },
    velocity_smooth: { data: new Array(n).fill(3) },
    heartrate: { data: new Array(n).fill(150) },
    cadence: { data: new Array(n).fill(85) }, // Strava: strides per minute (one leg)
    moving: { data: new Array(n).fill(true) },
  };
  const activity: StravaSummaryActivity = {
    id,
    name: "Morning Run",
    sport_type: "Run",
    type: "Run",
    start_date: start,
    utc_offset: 3600,
    distance: d,
    elapsed_time: 1260,
    moving_time: 1200,
    average_heartrate: 150,
    max_heartrate: 165,
    average_cadence: 85,
    total_elevation_gain: 0,
    trainer: false,
    manual: false,
    device_name: "Apple Watch Series 9",
    laps: [
      { start_index: 0, end_index: 600, elapsed_time: 600, moving_time: 600, distance: 1800, average_speed: 3, average_cadence: 85, average_heartrate: 148 },
      { start_index: 601, end_index: n - 1, elapsed_time: 660, moving_time: 600, distance: 1800, average_speed: 3, average_cadence: 85, average_heartrate: 152 },
    ],
  };
  return { activity, streams };
}

describe("normalizeStrava", () => {
  it("maps an Apple Watch run: steps/min cadence, pauses, laps, device", () => {
    const { activity, streams } = appleWatchRun();
    const a = normalizeStrava(decodeBundle(encodeBundle(activity, streams)));
    expect(a.sport).toBe("running");
    expect(a.subSport).toBe("generic");
    expect(a.device).toMatchObject({ manufacturer: "apple", product: "Apple Watch Series 9" });
    expect(a.utcOffsetS).toBe(3600);
    expect(a.streams.cadence[0]).toBe(170);
    expect(a.totals.avgCadence).toBe(170);
    expect(a.laps).toHaveLength(2);
    expect(a.laps[1].startOffsetS).toBe(660); // index 601 is the first sample after the pause
    expect(a.laps[0].avgCadence).toBe(170);
    expect(a.streams.lat[0]).toBeCloseTo(59.9);
    // the 60 s gap with no distance is a pause, not a stop
    expect(a.timerEvents).toEqual([
      { t: 0, type: "start" },
      { t: 600, type: "stop" },
      { t: 660, type: "start" },
    ]);
    const d = deriveActivity(a);
    expect(d.summary.timerS).toBe(1200);
    expect(d.summary.movingS).toBeCloseTo(1200, -1);
    expect(d.summary.distanceM).toBe(3600);
    expect(d.summary.hasGps).toBe(true);
    expect(d.splits.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps cadence already in steps/min, treats trainer runs as treadmill", () => {
    const { activity, streams } = appleWatchRun();
    streams.cadence = { data: streams.time!.data.map(() => 172) };
    const a = normalizeStrava({ version: 1, activity: { ...activity, trainer: true, average_cadence: 172 }, streams });
    expect(a.streams.cadence[5]).toBe(172);
    expect(a.subSport).toBe("treadmill");
    expect(deriveActivity(a).summary.isIndoor).toBe(true);
  });

  it("ignores a stream of the wrong length with a warning and rejects activities without samples", () => {
    const { activity, streams } = appleWatchRun();
    streams.heartrate = { data: [1, 2, 3] };
    const a = normalizeStrava({ version: 1, activity, streams });
    expect(a.streams.hr.every((v) => v == null)).toBe(true);
    expect(a.warnings.some((w) => w.includes("heartrate"))).toBe(true);
    expect(() => normalizeStrava({ version: 1, activity, streams: {} })).toThrow(StravaParseError);
    expect(() => decodeBundle(new TextEncoder().encode("nope"))).toThrow(StravaParseError);
  });
});

function fakeStrava(acts: { id: number; start: string; type?: string; manual?: boolean; fail?: "missing" | "ratelimit" | "auth" }[]) {
  const calls = { list: [] as { after?: number; before?: number; page: number }[], detail: 0 };
  const s: StravaLike = {
    async listActivities({ after, before, page, perPage }) {
      calls.list.push({ after, before, page });
      const inRange = acts.filter((a) => (after == null || Date.parse(a.start) / 1000 > after) && (before == null || Date.parse(a.start) / 1000 < before));
      return inRange.slice((page - 1) * perPage, page * perPage).map((a) => ({
        id: a.id,
        name: `Run ${a.id}`,
        sport_type: a.type ?? "Run",
        start_date: a.start,
        manual: a.manual ?? false,
      }));
    },
    async getActivity(id) {
      calls.detail++;
      const a = acts.find((x) => String(x.id) === id)!;
      if (a.fail === "missing") throw new StravaNotFoundError("gone", 404);
      if (a.fail === "ratelimit") throw new StravaRateLimitError("slow down", 429, true);
      if (a.fail === "auth") throw new StravaAuthError("revoked", 401);
      return appleWatchRun(a.id, a.start).activity;
    },
    async getStreams(id) {
      const a = acts.find((x) => String(x.id) === id)!;
      return appleWatchRun(a.id, a.start).streams;
    },
  };
  return { s, calls };
}

const NOW = new Date("2026-11-04T12:00:00Z");
const tick = (repo: MemoryIngestRepo, s: StravaLike) =>
  runSyncTick({ repo, source: stravaSource(s), now: () => NOW, deadline: Date.now() + 20_000 }, { createIncremental: true });

describe("Strava ingestion", () => {
  it("imports runs, skips rides and manual entries, and stores the JSON bundle", async () => {
    const repo = new MemoryIngestRepo();
    const { s, calls } = fakeStrava([
      { id: 11, start: "2026-10-20T06:00:00Z" },
      { id: 12, start: "2026-10-22T06:00:00Z", type: "Ride" },
      { id: 13, start: "2026-10-24T06:00:00Z", manual: true },
      { id: 14, start: "2026-10-26T06:00:00Z", type: "TrailRun" },
    ]);
    const res = await tick(repo, s);
    expect(res.done).toBe(true);
    expect(res.counters).toMatchObject({ discovered: 4, processed: 2, skipped: 2 });
    expect(calls.detail).toBe(2);
    expect([...repo.files.keys()].every((k) => /^strava\/1[14]\/[0-9a-f]{64}\.json$/.test(k))).toBe(true);
    expect(repo.raws.find((r) => r.externalId === "11")?.name).toBe("Run 11");
    // the incremental range defaults to the last 30 days, passed to Strava as epoch seconds with slack
    expect(calls.list[0].after).toBe(Date.parse("2026-10-05T00:00:00Z") / 1000 - 86400);
  });

  it("pages through a long history", async () => {
    const repo = new MemoryIngestRepo();
    const acts = Array.from({ length: 70 }, (_, i) => ({ id: 100 + i, start: new Date(Date.UTC(2026, 3, 1) + i * 2 * 86400_000).toISOString() }));
    const { s, calls } = fakeStrava(acts);
    await startHistoricalImport(repo, "2026-03-01", NOW);
    let res = await tick(repo, s);
    for (let i = 0; i < 5 && !res.done; i++) res = await tick(repo, s);
    expect(res.done).toBe(true);
    expect(res.counters?.processed).toBe(70);
    expect(calls.list.map((c) => c.page)).toEqual([1, 2]);
  });

  it("pauses on a rate limit without spending retries, and continues next tick", async () => {
    const repo = new MemoryIngestRepo();
    const acts: { id: number; start: string; fail?: "ratelimit" }[] = [
      { id: 21, start: "2026-10-28T06:00:00Z", fail: "ratelimit" },
      { id: 22, start: "2026-10-29T06:00:00Z" },
    ];
    const { s } = fakeStrava(acts);
    const res = await tick(repo, s);
    expect(res.paused).toMatch(/slow down/);
    expect(res.done).toBe(false);
    const r21 = repo.raws.find((r) => r.externalId === "21")!;
    expect(r21.status).toBe("discovered");
    expect(r21.attempts).toBe(0);
    delete acts[0].fail;
    const again = await tick(repo, s);
    expect(again.done).toBe(true);
    expect(again.counters?.processed).toBe(2);
  });

  it("reports revoked access as an auth error and deleted activities as unavailable", async () => {
    const repo = new MemoryIngestRepo();
    const { s } = fakeStrava([{ id: 31, start: "2026-10-28T06:00:00Z", fail: "missing" }]);
    const res = await tick(repo, s);
    expect(res.counters?.unavailable).toBe(1);

    const repo2 = new MemoryIngestRepo();
    const { s: s2 } = fakeStrava([{ id: 32, start: "2026-10-28T06:00:00Z", fail: "auth" }]);
    const res2 = await tick(repo2, s2);
    expect(res2.authError).toMatch(/revoked/);
  });
});

describe("StravaClient", () => {
  function setup(responses: ((url: string, init?: RequestInit) => Response)[], tokens: StravaTokens) {
    const saved: StravaTokens[] = [];
    const seen: string[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      return responses[i++](url, init);
    }) as unknown as typeof fetch;
    const client = new StravaClient({
      credentials: { clientId: "1", clientSecret: "s" },
      tokenStore: { load: async () => tokens, save: async (t) => void saved.push(t) },
      fetchImpl,
      apiBase: "https://api.test",
      oauthBase: "https://oauth.test",
    });
    return { client, saved, seen };
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
  const fresh = { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000) };

  it("refreshes an expiring token and saves the rotated refresh token", async () => {
    const { client, saved, seen } = setup(
      [json({ access_token: "a2", refresh_token: "r2", expires_at: Math.floor(Date.now() / 1000) + 21600 }), json([])],
      { ...fresh, expiresAt: new Date(Date.now() + 60_000) },
    );
    await client.listActivities({ page: 1, perPage: 50 });
    expect(seen).toEqual(["POST https://oauth.test/token", "GET https://api.test/athlete/activities"]);
    expect(saved[0]).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
  });

  it("retries once after a 401 with a refreshed token, then gives up as an auth error", async () => {
    const { client } = setup(
      [json({}, 401), json({ access_token: "a2", refresh_token: "r2", expires_at: 9999999999 }), json({}, 401)],
      fresh,
    );
    await expect(client.getActivity("5")).rejects.toBeInstanceOf(StravaAuthError);
  });

  it("maps 404 and 429", async () => {
    const a = setup([json({}, 404)], fresh);
    await expect(a.client.getStreams("5")).rejects.toBeInstanceOf(StravaNotFoundError);
    const b = setup([json({}, 429)], fresh);
    await expect(b.client.getStreams("5")).rejects.toBeInstanceOf(StravaRateLimitError);
  });

  it("treats a rejected refresh token as an auth error", async () => {
    const { client } = setup([json({ message: "Bad Request", errors: [{ resource: "RefreshToken", code: "invalid" }] }, 400)], {
      ...fresh,
      expiresAt: new Date(0),
    });
    await expect(client.listActivities({ page: 1, perPage: 1 })).rejects.toBeInstanceOf(StravaAuthError);
  });
});

describe("OAuth state", () => {
  it("round-trips the user id and rejects tampering and expiry", () => {
    const st = signState("user-1", 1_000);
    expect(verifyState(st, 2_000)).toBe("user-1");
    expect(verifyState(st, 1_000 + 16 * 60_000)).toBeNull();
    const [p, sig] = st.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-2", e: 9e15, n: "x" })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, 2_000)).toBeNull();
    expect(verifyState(`${p}.`, 2_000)).toBeNull();
    expect(verifyState("garbage", 2_000)).toBeNull();
  });
});
