import { unzipSync } from "fflate";
import { fingerprint } from "../../crypto/secretbox";

/**
 * Client for the official Garmin Connect Personal API.
 * Docs: https://developer.garmin.com/gc-developer-program/personal/personal-api/
 *
 * Auth: the long-lived Personal API key is exchanged for a 24 h access token
 * (JWT). There is no refresh token; we simply exchange the key again when the
 * token has < 1 h left or a call returns 401.
 *
 * Unverified details (not in the readable docs) are isolated here and
 * configurable: data host (`GARMIN_API_BASE_URL`), and the Bearer header.
 */

export const GARMIN_TOKEN_URL =
  "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
export const GARMIN_DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
const JSON_ACCEPT = "application/json";
const ARCHIVE_ACCEPT = "application/zip, application/x-zip-compressed, application/octet-stream";

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export class GarminAuthError extends GarminError {}
export class GarminNotFoundError extends GarminError {}

export interface CachedToken {
  accessToken: string;
  expiresAt: Date;
  keyFingerprint: string;
}

export interface TokenStore {
  load(): Promise<CachedToken | null>;
  save(token: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export interface GarminClientOptions {
  apiKey: string;
  tokenStore: TokenStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxRetries?: number;
  /** Minimum spacing between requests, to stay well under undocumented rate limits. */
  minIntervalMs?: number;
}

const TOKEN_MIN_REMAINING_MS = 60 * 60 * 1000;

/** Decode a JWT's `exp` claim without verifying (Garmin verifies it, we only schedule renewal). */
export function jwtExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Accepts the token endpoint's body whether it is a bare JWT or a JSON object. */
export function parseTokenResponse(body: string, now: Date): { accessToken: string; expiresAt: Date } {
  const trimmed = body.trim();
  let token: string | undefined;
  let expiresIn: number | undefined;
  if (trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    token = j.access_token ?? j.accessToken ?? j.token ?? j.jwt;
    expiresIn = j.expires_in ?? j.expiresIn;
  } else {
    token = trimmed.replace(/^"|"$/g, "");
  }
  if (!token) throw new GarminAuthError("Token endpoint returned no access token");
  const exp =
    jwtExpiry(token) ?? (expiresIn ? new Date(now.getTime() + expiresIn * 1000) : new Date(now.getTime() + 23 * 3600_000));
  return { accessToken: token, expiresAt: exp };
}

export class GarminPersonalApiClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly keyFp: string;
  private token: CachedToken | null = null;
  private lastRequestAt = 0;
  /** Number of HTTP requests made, for diagnostics. */
  requestCount = 0;

  constructor(private readonly opts: GarminClientOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
    this.baseUrl = (opts.baseUrl ?? GARMIN_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxRetries = opts.maxRetries ?? 4;
    this.minIntervalMs = opts.minIntervalMs ?? 400;
    this.keyFp = fingerprint(opts.apiKey);
  }

  async getAccessToken(force = false): Promise<string> {
    const now = this.now().getTime();
    const fresh = (t: CachedToken | null) =>
      t && t.keyFingerprint === this.keyFp && t.expiresAt.getTime() - now > TOKEN_MIN_REMAINING_MS;
    if (!force) {
      if (fresh(this.token)) return this.token!.accessToken;
      const stored = await this.opts.tokenStore.load();
      if (fresh(stored)) {
        this.token = stored;
        return stored!.accessToken;
      }
    }
    const res = await this.withRetries(() =>
      this.fetch(GARMIN_TOKEN_URL, {
        method: "POST",
        // Match Garmin's official client exactly: the endpoint answers with a plain-text JWT
        // and returns HTTP 406 when Accept is narrowed to application/json.
        headers: { Authorization: `ApiKey ${this.opts.apiKey}`, Accept: "*/*" },
      }),
    );
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      await this.opts.tokenStore.clear();
      throw new GarminAuthError("Garmin rejected the Personal API key (expired, deleted or invalid)", res.status);
    }
    if (!res.ok) {
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new GarminError(`Token request failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status, res.status >= 500);
    }
    const parsed = parseTokenResponse(body, this.now());
    this.token = { ...parsed, keyFingerprint: this.keyFp };
    await this.opts.tokenStore.save(this.token);
    return parsed.accessToken;
  }

  /** Retries network errors, 429 and 5xx with exponential backoff, honouring Retry-After. */
  private async withRetries(doFetch: () => Promise<Response>): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      this.requestCount++;
      let res: Response | null = null;
      let err: unknown = null;
      try {
        res = await doFetch();
      } catch (e) {
        err = e;
      }
      const retryable = err != null || (res != null && (res.status === 429 || res.status >= 500));
      if (!retryable) return res!;
      if (attempt >= this.maxRetries) {
        if (res) return res;
        throw new GarminError(`Network error contacting Garmin: ${String((err as Error)?.message ?? err)}`, undefined, true);
      }
      const retryAfter = Number(res?.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt + Math.random() * 250;
      await this.sleep(Math.min(backoff, 60_000));
      attempt++;
    }
  }

  private async request(
    path: string,
    params: Record<string, string | number | undefined> = {},
    accept = JSON_ACCEPT,
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let reauthed = false;
    for (;;) {
      const token = await this.getAccessToken();
      const res = await this.withRetries(() =>
        this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } }),
      );
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        this.token = null;
        await this.opts.tokenStore.clear();
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new GarminAuthError(`Garmin denied access to ${path}`, res.status);
      if (res.status === 404) throw new GarminNotFoundError(`Not found: ${path}`, 404);
      if (!res.ok) throw new GarminError(`Garmin ${path} failed: HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500);
      return res;
    }
  }

  async getJson<T = unknown>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.request(path, params);
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GarminError(`Garmin ${path} returned non-JSON content`, res.status);
    }
  }

  /** One page of the activity list. Dates are YYYY-MM-DD. */
  listActivities(p: { start: number; limit: number; startDate?: string; endDate?: string }) {
    return this.getJson<unknown[]>("/activitylist-service/activities/search/activities", p);
  }

  getActivity(activityId: string) {
    return this.getJson(`/activity-service/activity/${encodeURIComponent(activityId)}`);
  }

  /** Downloads the original recording and returns the FIT bytes (the API wraps it in a ZIP). */
  async downloadOriginalFit(activityId: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const res = await this.request(`/download-service/files/activity/${encodeURIComponent(activityId)}`, {}, ARCHIVE_ACCEPT);
    const buf = new Uint8Array(await res.arrayBuffer());
    return extractFit(buf, activityId);
  }

  // --- wellness (supplementary) ---
  sleepSummaries(startDate: string, endDate: string) {
    return this.getJson("/sleep-service/sleep/dailySleepSummariesByDate", { startDate, endDate });
  }
  hrvDaily(startDate: string, endDate: string) {
    return this.getJson(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
  }
  stressDaily(startDate: string, endDate: string) {
    return this.getJson(`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`);
  }
  bodyBatteryDaily(startDate: string, endDate: string) {
    return this.getJson("/wellness-service/wellness/bodyBattery/reports/daily", { startDate, endDate });
  }
  dailySummaries(startDate: string, endDate: string) {
    return this.getJson("/usersummary-service/v2/dailysummaries", { startDate, endDate });
  }
}

const isFitHeader = (b: Uint8Array) =>
  b.length > 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54; // ".FIT"

export class NotFitError extends GarminError {}

export function extractFit(buf: Uint8Array, activityId: string): { bytes: Uint8Array; filename: string } {
  if (isFitHeader(buf)) return { bytes: buf, filename: `${activityId}.fit` };
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    const entry = Object.entries(files).find(([name, data]) => name.toLowerCase().endsWith(".fit") || isFitHeader(data));
    if (entry) return { bytes: entry[1], filename: entry[0] };
    throw new NotFitError(`Archive for ${activityId} has no FIT file (contains: ${Object.keys(files).join(", ") || "nothing"})`);
  }
  throw new NotFitError(`Original file for ${activityId} is neither FIT nor ZIP`);
}
