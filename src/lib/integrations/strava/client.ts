/**
 * Minimal Strava API v3 client (read-only activity import).
 * Docs: https://developers.strava.com/docs/reference/ · https://developers.strava.com/docs/authentication/
 *
 * Auth is OAuth2 with short-lived access tokens (6 h) and a refresh token that
 * may rotate on every refresh, so both are persisted through a TokenStore.
 */

export const STRAVA_API_BASE = "https://www.strava.com/api/v3";
export const STRAVA_OAUTH_BASE = "https://www.strava.com/oauth";
export const STRAVA_SCOPE = "read,activity:read_all";

export class StravaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}
/** The athlete revoked access, or the app credentials are wrong: needs a reconnect. */
export class StravaAuthError extends StravaError {}
export class StravaNotFoundError extends StravaError {}
/** Strava's 15-minute / daily request limits. Stop for now; the next tick continues. */
export class StravaRateLimitError extends StravaError {}

export interface StravaCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface StravaTokenStore {
  load(): Promise<StravaTokens | null>;
  save(t: StravaTokens): Promise<void>;
}

export interface StravaAthlete {
  id: number;
  firstname?: string | null;
  lastname?: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type StravaSummaryActivity = Record<string, any> & { id: number; start_date?: string; sport_type?: string; type?: string; name?: string };
export type StravaStreams = Record<string, { data: any[] } | undefined>;

export const STREAM_KEYS = ["time", "distance", "latlng", "altitude", "velocity_smooth", "heartrate", "cadence", "moving"] as const;

export interface StravaClientOptions {
  credentials: StravaCredentials;
  tokenStore: StravaTokenStore;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  oauthBase?: string;
  timeoutMs?: number;
}

function oauthBase(override?: string) {
  return (override ?? process.env.STRAVA_OAUTH_BASE_URL ?? STRAVA_OAUTH_BASE).replace(/\/$/, "");
}

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; oauthBase?: string }): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: STRAVA_SCOPE,
    state: opts.state,
  });
  return `${oauthBase(opts.oauthBase)}/authorize?${q}`;
}

async function tokenRequest(
  creds: StravaCredentials,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  base?: string,
): Promise<StravaTokens & { athlete?: StravaAthlete; scope?: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${oauthBase(base)}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }),
      cache: "no-store",
    });
  } catch (e) {
    throw new StravaError(`Couldn't reach Strava: ${e instanceof Error ? e.message : e}`, undefined, true);
  }
  const body: any = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new StravaAuthError(`Strava rejected the ${params.grant_type === "authorization_code" ? "authorization" : "saved login"}: ${describeError(body) ?? `HTTP ${res.status}`}`, res.status);
  }
  if (res.status === 429) throw new StravaRateLimitError("Strava rate limit reached", 429, true);
  if (!res.ok || !body?.access_token || !body?.refresh_token) {
    throw new StravaError(`Strava token request failed (HTTP ${res.status})`, res.status, res.status >= 500);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Number(body.expires_at) * 1000),
    athlete: body.athlete,
  };
}

/** Exchanges the OAuth `code` from the redirect for tokens (and the athlete). */
export function exchangeCode(creds: StravaCredentials, code: string, fetchImpl?: typeof fetch, base?: string) {
  return tokenRequest(creds, { code, grant_type: "authorization_code" }, fetchImpl, base);
}

function describeError(body: any): string | null {
  if (!body) return null;
  const errs = Array.isArray(body.errors) ? body.errors.map((e: any) => [e.resource, e.field, e.code].filter(Boolean).join(" ")).join(", ") : "";
  return [body.message, errs].filter(Boolean).join(": ") || null;
}

export class StravaClient {
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private tokens: StravaTokens | null = null;

  constructor(private readonly opts: StravaClientOptions) {
    this.api = (opts.apiBase ?? process.env.STRAVA_API_BASE_URL ?? STRAVA_API_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    this.tokens ??= await this.opts.tokenStore.load();
    if (!this.tokens) throw new StravaAuthError("Strava isn't connected yet");
    if (forceRefresh || this.tokens.expiresAt.getTime() - Date.now() < 5 * 60_000) {
      const t = await tokenRequest(
        this.opts.credentials,
        { grant_type: "refresh_token", refresh_token: this.tokens.refreshToken },
        this.fetchImpl,
        this.opts.oauthBase,
      );
      this.tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
      await this.opts.tokenStore.save(this.tokens);
    }
    return this.tokens.accessToken;
  }

  private async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`
      : "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.api}${path}${qs}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        });
      } catch (e) {
        throw new StravaError(`Couldn't reach Strava: ${e instanceof Error ? e.message : e}`, undefined, true);
      }
      if (res.status === 401 && attempt === 0) continue; // token revoked or expired early: refresh once
      if (res.status === 401 || res.status === 403) throw new StravaAuthError(`Strava denied access (HTTP ${res.status}). Reconnect Strava.`, res.status);
      if (res.status === 404) throw new StravaNotFoundError(`Not found on Strava: ${path}`, 404);
      if (res.status === 429) throw new StravaRateLimitError("Strava rate limit reached; continuing on the next sync", 429, true);
      if (!res.ok) throw new StravaError(`Strava API error (HTTP ${res.status})`, res.status, res.status >= 500);
      return (await res.json()) as T;
    }
    throw new StravaAuthError("Strava denied access. Reconnect Strava.", 401);
  }

  /** Activities in [after, before) (epoch seconds), newest data first is not guaranteed. */
  listActivities(args: { after?: number; before?: number; page: number; perPage: number }) {
    return this.get<StravaSummaryActivity[]>("/athlete/activities", { after: args.after, before: args.before, page: args.page, per_page: args.perPage });
  }

  getActivity(id: string) {
    return this.get<StravaSummaryActivity>(`/activities/${encodeURIComponent(id)}`, { include_all_efforts: "false" });
  }

  getStreams(id: string) {
    return this.get<StravaStreams>(`/activities/${encodeURIComponent(id)}/streams`, { keys: STREAM_KEYS.join(","), key_by_type: "true" });
  }
}

/* ---------- Webhook subscriptions (one per Strava API app) ---------- */

export interface WebhookSubscription {
  id: number;
  callback_url: string;
}

async function subscriptionRequest(method: string, creds: StravaCredentials, params: Record<string, string>, fetchImpl: typeof fetch = fetch, path = "") {
  const base = (process.env.STRAVA_API_BASE_URL ?? STRAVA_API_BASE).replace(/\/$/, "");
  const body = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params });
  const url = method === "POST" ? `${base}/push_subscriptions${path}` : `${base}/push_subscriptions${path}?${body}`;
  const res = await fetchImpl(url, {
    method,
    headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: method === "POST" ? body : undefined,
    cache: "no-store",
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok && res.status !== 204) throw new StravaError(`Strava webhook ${method} failed: ${describeError(json) ?? `HTTP ${res.status}`}`, res.status);
  return json;
}

/**
 * Makes sure the app's single webhook subscription points at `callbackUrl`.
 * Strava calls the callback (GET with hub.challenge) before this returns.
 */
export async function ensureWebhook(creds: StravaCredentials, callbackUrl: string, verifyToken: string, fetchImpl?: typeof fetch): Promise<number> {
  const existing = ((await subscriptionRequest("GET", creds, {}, fetchImpl)) ?? []) as WebhookSubscription[];
  const same = existing.find((s) => s.callback_url === callbackUrl);
  if (same) return same.id;
  for (const s of existing) await subscriptionRequest("DELETE", creds, {}, fetchImpl, `/${s.id}`);
  const created = await subscriptionRequest("POST", creds, { callback_url: callbackUrl, verify_token: verifyToken }, fetchImpl);
  return Number(created.id);
}
