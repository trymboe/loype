import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  GARMIN_TOKEN_URL,
  GarminAuthError,
  GarminPersonalApiClient,
  extractFit,
  parseTokenResponse,
  type CachedToken,
  type TokenStore,
} from "@/lib/integrations/garmin/client";
import { parseActivityRef } from "@/lib/integrations/garmin/summary";
import { buildFit } from "./fit-builder";

const jwt = (exp: number) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

class MemTokenStore implements TokenStore {
  t: CachedToken | null = null;
  async load() {
    return this.t;
  }
  async save(t: CachedToken) {
    this.t = t;
  }
  async clear() {
    this.t = null;
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const log: { url: string; auth: string | null; accept: string | null; method: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    log.push({ url, auth: h.get("authorization"), accept: h.get("accept"), method: init?.method ?? "GET" });
    return handler(url, init);
  }) as typeof fetch;
  return { f, log };
}

const now = new Date("2026-11-01T12:00:00Z");
const nowS = now.getTime() / 1000;
const opts = (f: typeof fetch, store = new MemTokenStore()) => ({
  apiKey: "test-key",
  tokenStore: store,
  fetchImpl: f,
  sleep: async () => {},
  now: () => now,
  minIntervalMs: 0,
});

describe("Garmin token handling", () => {
  it("exchanges the API key for a token and reuses it", async () => {
    const { f, log } = fakeFetch((url) =>
      url === GARMIN_TOKEN_URL ? new Response(jwt(nowS + 24 * 3600)) : Response.json([]),
    );
    const c = new GarminPersonalApiClient(opts(f));
    await c.listActivities({ start: 0, limit: 10 });
    await c.listActivities({ start: 10, limit: 10 });
    expect(log.filter((l) => l.url === GARMIN_TOKEN_URL)).toHaveLength(1);
    expect(log[0].auth).toBe("ApiKey test-key");
    expect(log[1].auth).toMatch(/^Bearer ey/);
    expect(log[1].url).toContain("/activitylist-service/activities/search/activities?start=0&limit=10");
  });

  it("sends the same headers as Garmin's official client (narrow Accept on the token call gives HTTP 406)", async () => {
    const zip = zipSync({ "1.fit": buildFit({ segments: [{ durationS: 30, speedMs: 3, hr: 140 }] }) });
    const { f, log } = fakeFetch((url) =>
      url === GARMIN_TOKEN_URL ? new Response(jwt(nowS + 86400)) : url.includes("download-service") ? new Response(zip) : Response.json([]),
    );
    const c = new GarminPersonalApiClient(opts(f));
    await c.listActivities({ start: 0, limit: 1 });
    await c.downloadOriginalFit("1");
    expect(log[0]).toMatchObject({ method: "POST", auth: "ApiKey test-key", accept: "*/*" });
    expect(log[1].accept).toBe("application/json");
    expect(log[2].accept).toContain("application/zip");
  });

  it("renews a token that has less than an hour left", async () => {
    const store = new MemTokenStore();
    const { fingerprint } = await import("@/lib/crypto/secretbox");
    store.t = { accessToken: "old", expiresAt: new Date(now.getTime() + 30 * 60_000), keyFingerprint: fingerprint("test-key") };
    const { f, log } = fakeFetch((url) => (url === GARMIN_TOKEN_URL ? new Response(jwt(nowS + 86400)) : Response.json([])));
    await new GarminPersonalApiClient(opts(f, store)).listActivities({ start: 0, limit: 1 });
    expect(log[0].url).toBe(GARMIN_TOKEN_URL);
  });

  it("re-authenticates once on 401, then surfaces an auth error", async () => {
    let tokenCalls = 0;
    const { f } = fakeFetch((url) => {
      if (url === GARMIN_TOKEN_URL) {
        tokenCalls++;
        return new Response(jwt(nowS + 86400));
      }
      return new Response("nope", { status: 401 });
    });
    await expect(new GarminPersonalApiClient(opts(f)).listActivities({ start: 0, limit: 1 })).rejects.toBeInstanceOf(GarminAuthError);
    expect(tokenCalls).toBe(2);
  });

  it("retries 429/503 responses", async () => {
    let n = 0;
    const { f } = fakeFetch((url) => {
      if (url === GARMIN_TOKEN_URL) return new Response(jwt(nowS + 86400));
      n++;
      return n < 3 ? new Response("busy", { status: n === 1 ? 429 : 503, headers: { "retry-after": "1" } }) : Response.json([{ activityId: 1 }]);
    });
    const res = await new GarminPersonalApiClient(opts(f)).listActivities({ start: 0, limit: 1 });
    expect(res).toEqual([{ activityId: 1 }]);
  });

  it("accepts JSON token responses", () => {
    const r = parseTokenResponse(JSON.stringify({ access_token: "abc", expires_in: 3600 }), now);
    expect(r.accessToken).toBe("abc");
    expect(r.expiresAt.getTime()).toBe(now.getTime() + 3600_000);
  });
});

describe("original file extraction", () => {
  const fit = buildFit({ segments: [{ durationS: 60, speedMs: 3, hr: 140 }] });
  it("unzips the FIT file from Garmin's ZIP", () => {
    const zip = zipSync({ "123_ACTIVITY.fit": fit });
    expect(extractFit(zip, "123").bytes).toEqual(fit);
  });
  it("accepts a bare FIT file", () => {
    expect(extractFit(fit, "123").filename).toBe("123.fit");
  });
});

describe("parseActivityRef", () => {
  it("reads id, type and GMT start time", () => {
    const r = parseActivityRef({ activityId: 42, startTimeGMT: "2026-10-01 06:00:00", activityType: { typeKey: "trail_running" } });
    expect(r).toMatchObject({ externalId: "42", type: "trail_running" });
    expect(r!.startTime!.toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });
});
