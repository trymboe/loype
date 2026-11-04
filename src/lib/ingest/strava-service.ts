import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, fingerprint } from "../crypto/secretbox";
import {
  ensureWebhook,
  exchangeCode,
  StravaAuthError,
  StravaClient,
  type StravaCredentials,
  type StravaTokenStore,
} from "../integrations/strava/client";
import { stravaSource } from "../integrations/strava/source";
import { runSyncTick, startHistoricalImport, type TickResult } from "./engine";
import { SupabaseIngestRepo } from "./supabase-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROVIDER = "strava";
const where = (q: any, userId: string) => q.eq("user_id", userId).eq("provider", PROVIDER);

export async function getStravaIntegration(db: SupabaseClient, userId: string) {
  const { data, error } = await where(db.from("integrations").select("*"), userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as any | null;
}

async function patchIntegration(db: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  const { error } = await where(db.from("integrations").update(patch), userId);
  if (error) throw new Error(error.message);
}

export function readCredentials(row: any): StravaCredentials | null {
  if (!row?.api_key_ciphertext) return null;
  try {
    const c = JSON.parse(decryptSecret(row.api_key_ciphertext));
    return c?.clientId && c?.clientSecret ? { clientId: String(c.clientId), clientSecret: String(c.clientSecret) } : null;
  } catch {
    return null;
  }
}

/** Step 1: store the user's Strava API app (client id + secret), before the OAuth redirect. */
export async function saveStravaApp(db: SupabaseClient, userId: string, creds: StravaCredentials) {
  const box = encryptSecret(JSON.stringify(creds));
  const existing = await getStravaIntegration(db, userId);
  const sameApp = existing && readCredentials(existing)?.clientId === creds.clientId;
  const patch = {
    api_key_ciphertext: box,
    api_key_fingerprint: fingerprint(creds.clientId),
    // a different app can't use the old app's tokens
    ...(sameApp ? {} : { secret_ciphertext: null, token_expires_at: null, status: "not_configured" }),
  };
  if (existing) await patchIntegration(db, userId, patch);
  else {
    const { error } = await db.from("integrations").insert({ user_id: userId, provider: PROVIDER, status: "not_configured", ...patch });
    if (error) throw new Error(error.message);
  }
}

/* ---------- OAuth state: signed, so the callback works even without the app's session cookie ---------- */
// (On iPhone, Strava's app may hand the redirect to Safari, which doesn't share the home-screen app's login.)

function stateKey(): Buffer {
  const k = process.env.TOKEN_ENCRYPTION_KEY;
  if (!k) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  return createHmac("sha256", Buffer.from(k, "base64")).update("strava-oauth-state").digest();
}

export function signState(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + 15 * 60_000, n: randomBytes(6).toString("hex") })).toString("base64url");
  const sig = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string, now = Date.now()): string | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const want = createHmac("sha256", stateKey()).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p.u !== "string" || typeof p.e !== "number" || p.e < now) return null;
    return p.u;
  } catch {
    return null;
  }
}

function tokenStore(db: SupabaseClient, userId: string): StravaTokenStore {
  return {
    async load() {
      const { data } = await where(db.from("integrations").select("secret_ciphertext, token_expires_at"), userId).maybeSingle();
      if (!data?.secret_ciphertext || !data.token_expires_at) return null;
      try {
        const t = JSON.parse(decryptSecret(data.secret_ciphertext));
        return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: new Date(data.token_expires_at) };
      } catch {
        return null;
      }
    },
    async save(t) {
      await patchIntegration(db, userId, {
        secret_ciphertext: encryptSecret(JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken })),
        token_expires_at: t.expiresAt.toISOString(),
      });
    },
  };
}

export async function buildStravaClient(db: SupabaseClient, userId: string): Promise<StravaClient | null> {
  const row = await getStravaIntegration(db, userId);
  const creds = readCredentials(row);
  if (!creds || !row?.secret_ciphertext) return null;
  return new StravaClient({ credentials: creds, tokenStore: tokenStore(db, userId) });
}

export function webhookUrl(origin: string) {
  return `${origin.replace(/\/$/, "")}/api/strava/webhook`;
}

/**
 * Step 2: OAuth callback. Stores the tokens, registers the webhook (best
 * effort: the 30-minute sync covers for it) and queues the first import.
 */
export async function completeStravaConnect(db: SupabaseClient, userId: string, code: string, scope: string | null, origin: string): Promise<{ webhook: boolean }> {
  const row = await getStravaIntegration(db, userId);
  const creds = readCredentials(row);
  if (!creds) throw new StravaAuthError("Save your Strava app's Client ID and Secret first");
  if (scope != null && !scope.split(",").includes("activity:read_all") && !scope.split(",").includes("activity:read")) {
    throw new StravaAuthError("Løype needs permission to read your activities. Connect again and keep “View data about your activities” ticked.");
  }
  const t = await exchangeCode(creds, code);
  await tokenStore(db, userId).save(t);
  const verifyToken = randomBytes(16).toString("hex");
  const athleteName = [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(" ") || null;
  const settings = { ...(row?.settings ?? {}), athleteId: t.athlete?.id ?? null, athleteName, scope, webhookVerifyToken: verifyToken };
  await patchIntegration(db, userId, { status: "connected", last_error: null, settings });

  let webhook = false;
  try {
    const id = await ensureWebhook(creds, webhookUrl(origin), verifyToken);
    await patchIntegration(db, userId, { settings: { ...settings, webhookId: id, webhookUrl: webhookUrl(origin) } });
    webhook = true;
  } catch (e) {
    await patchIntegration(db, userId, { settings: { ...settings, webhookId: null, webhookError: e instanceof Error ? e.message.slice(0, 300) : String(e) } });
  }
  return { webhook };
}

export async function disconnectStrava(db: SupabaseClient, userId: string) {
  const client = await buildStravaClient(db, userId);
  const row = await getStravaIntegration(db, userId);
  if (client && row?.secret_ciphertext) {
    try {
      const t = JSON.parse(decryptSecret(row.secret_ciphertext));
      await fetch("https://www.strava.com/oauth/deauthorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ access_token: t.accessToken }),
      });
    } catch {
      // best effort: the tokens are dropped below either way
    }
  }
  await patchIntegration(db, userId, { secret_ciphertext: null, token_expires_at: null, status: "not_configured", last_error: null });
}

/** The user whose Strava athlete id this is (webhook events carry only the owner id). */
export async function userForAthlete(db: SupabaseClient, athleteId: number): Promise<string | null> {
  const { data } = await db.from("integrations").select("user_id, settings, status").eq("provider", PROVIDER).neq("status", "not_configured");
  const hit = (data ?? []).find((r: any) => Number(r.settings?.athleteId) === athleteId);
  return hit?.user_id ?? null;
}

export interface StravaTickOutcome extends Partial<TickResult> {
  configured: boolean;
  error?: string;
}

/** One bounded unit of Strava import work for a user. */
export async function stravaTick(
  db: SupabaseClient,
  userId: string,
  timezone: string,
  opts: { deadline: number; createIncremental: boolean; historicalFrom?: string },
): Promise<StravaTickOutcome> {
  const row = await getStravaIntegration(db, userId);
  if (!row || row.status === "not_configured") return { configured: false };
  const client = await buildStravaClient(db, userId);
  if (!client) return { configured: false };
  const repo = new SupabaseIngestRepo(db, userId, timezone, PROVIDER);
  if (opts.historicalFrom) await startHistoricalImport(repo, opts.historicalFrom, new Date());

  let result: TickResult;
  try {
    result = await runSyncTick({ repo, source: stravaSource(client), deadline: opts.deadline }, { createIncremental: opts.createIncremental });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await patchIntegration(db, userId, { status: "error", last_error: msg, last_error_at: new Date().toISOString() });
    return { configured: true, error: msg };
  }
  if (result.authError) {
    await patchIntegration(db, userId, { status: "needs_reauth", last_error: result.authError, last_error_at: new Date().toISOString() });
  } else {
    // a rate-limit pause is not a failure: the next tick picks up where this one stopped
    await patchIntegration(db, userId, { status: "connected", last_success_at: new Date().toISOString(), last_error: null });
  }
  return { configured: true, ...result };
}
