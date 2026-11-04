/**
 * Minimal Intervals.icu API client (outbound workouts only).
 * Docs: https://intervals.icu/api-docs.html · https://forum.intervals.icu/t/api-access-to-intervals-icu/609
 *
 * Auth: HTTP Basic with user `API_KEY` and the personal API key as password.
 * Athlete id `0` means "the athlete who owns the key".
 */
import type { AthleteRunSettings, IntervalsEvent } from "./encode";

export const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

export class IntervalsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export class IntervalsAuthError extends IntervalsError {}

export interface RemoteEvent {
  id: number;
  external_id?: string | null;
  start_date_local?: string;
  name?: string;
  workout_doc?: { steps?: unknown[] } | null;
}

export interface AthleteInfo {
  id: string;
  name: string | null;
  run: AthleteRunSettings & { thresholdPaceSPerKm: number | null };
}

export interface IntervalsClientOptions {
  apiKey: string;
  athleteId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class IntervalsClient {
  private readonly base: string;
  private readonly athlete: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: IntervalsClientOptions) {
    this.base = (opts.baseUrl ?? process.env.INTERVALS_API_BASE_URL ?? INTERVALS_BASE_URL).replace(/\/$/, "");
    this.athlete = opts.athleteId?.trim() || "0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`API_KEY:${this.opts.apiKey}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        cache: "no-store",
      });
    } catch (e) {
      throw new IntervalsError(`Intervals.icu couldn't be reached (${e instanceof Error ? e.name : "network error"})`);
    }
    if (res.status === 401 || res.status === 403) throw new IntervalsAuthError("Intervals.icu rejected the API key", res.status);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new IntervalsError(`Intervals.icu returned HTTP ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Verifies the key and reads the Run settings that decide how targets are encoded. */
  async getAthlete(): Promise<AthleteInfo> {
    const a = await this.request<any>("GET", `/athlete/${this.athlete}`); // eslint-disable-line @typescript-eslint/no-explicit-any
    return parseAthlete(a);
  }

  /** Create or update by `external_id` (idempotent). Returns the stored events, including Intervals.icu's parsed `workout_doc`. */
  async upsertEvents(events: IntervalsEvent[]): Promise<RemoteEvent[]> {
    if (!events.length) return [];
    return (await this.request<RemoteEvent[]>("POST", `/athlete/${this.athlete}/events/bulk?upsert=true`, events)) ?? [];
  }

  /** Delete by `external_id`; unknown ids are ignored by Intervals.icu. */
  async deleteEvents(externalIds: string[]): Promise<void> {
    if (!externalIds.length) return;
    await this.request("PUT", `/athlete/${this.athlete}/events/bulk-delete`, externalIds.map((external_id) => ({ external_id })));
  }

  async listEvents(oldest: string, newest: string): Promise<RemoteEvent[]> {
    const q = new URLSearchParams({ oldest, newest, category: "WORKOUT" });
    return (await this.request<RemoteEvent[]>("GET", `/athlete/${this.athlete}/events?${q}`)) ?? [];
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseAthlete(a: any): AthleteInfo {
  const settings: any[] = Array.isArray(a?.sportSettings) ? a.sportSettings : [];
  const run = settings.find((s) => Array.isArray(s?.types) && s.types.includes("Run")) ?? null;
  // threshold_pace is stored in m/s
  const tp = typeof run?.threshold_pace === "number" && run.threshold_pace > 0 ? run.threshold_pace : null;
  const maxHr = typeof run?.max_hr === "number" && run.max_hr > 100 ? run.max_hr : typeof a?.icu_max_hr === "number" && a.icu_max_hr > 100 ? a.icu_max_hr : null;
  return {
    id: String(a?.id ?? ""),
    name: typeof a?.name === "string" ? a.name : null,
    run: { hasThresholdPace: tp != null, thresholdPaceSPerKm: tp ? Math.round(1000 / tp) : null, maxHr },
  };
}
