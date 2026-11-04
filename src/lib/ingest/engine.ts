import { createHash } from "node:crypto";
import { findDuplicate } from "../analytics/dedupe";
import { deriveActivity } from "../analytics/summarize";
import { FitParseError, parseFitActivity } from "../fit/parse";
import {
  GarminAuthError,
  GarminNotFoundError,
  NotFitError,
  type GarminPersonalApiClient,
} from "../integrations/garmin/client";
import { isRunningType, parseActivityRef } from "../integrations/garmin/summary";
import type { DiscoveredItem, IngestRepo, JobCounters, RawSourceRow, SyncJob } from "./types";
import type { NormalizedActivity } from "../fit/types";

/**
 * Durable, resumable activity ingestion (Garmin, Strava).
 *
 * A tick does a bounded amount of work and returns before `deadline`:
 *   1. discovery: page through the activity list for the job's date range and
 *      record every activity in raw_activity_sources (idempotent);
 *   2. processing: download → store original → parse → derive → save.
 * State lives entirely in the database, so a crashed or timed-out tick is
 * simply continued by the next one.
 */

export const PAGE_SIZE = 50;
export const MAX_ATTEMPTS = 6;
export const INCREMENTAL_OVERLAP_DAYS = 3;
export const INCREMENTAL_DEFAULT_LOOKBACK_DAYS = 30;
export const RUN_SPORTS = new Set(["running", "walking", "hiking", "training", "generic", "unknown"]);

export type GarminLike = Pick<GarminPersonalApiClient, "listActivities" | "downloadOriginalFit">;

/** What the engine does with an error from a source. */
export type ErrorClass =
  | "auth" // credentials rejected: stop the tick, surface "reconnect"
  | "stop" // e.g. rate limited: stop the tick quietly, next tick continues
  | "unavailable" // the activity is gone / has no file: never retry
  | "permanent" // the file can't be parsed: fail without further retries
  | "retry";

/**
 * A provider of recorded activities (Garmin, Strava). The engine owns the
 * job/queue bookkeeping; a source only lists, downloads and parses.
 */
export interface ActivitySource {
  /** Storage prefix and file extension for the stored original. */
  name: string;
  fileExt: string;
  listPage(args: { offset: number; limit: number; rangeStart: string | null; rangeEnd: string | null }): Promise<{
    items: DiscoveredItem[];
    /** entries returned by the provider (before filtering) */
    count: number;
    /** the provider returned entries older than the range: discovery is complete */
    reachedOlder: boolean;
  }>;
  download(externalId: string): Promise<Uint8Array>;
  parse(bytes: Uint8Array): NormalizedActivity;
  classifyError(e: unknown): ErrorClass;
}

export class SourceAuthError extends Error {}
class StopTick extends Error {}

export function garminSource(garmin: GarminLike): ActivitySource {
  return {
    name: "garmin",
    fileExt: "fit",
    async listPage({ offset, limit, rangeStart, rangeEnd }) {
      const page = await garmin.listActivities({ start: offset, limit, startDate: rangeStart ?? undefined, endDate: rangeEnd ?? undefined });
      const entries = Array.isArray(page) ? page : [];
      const rangeStartMs = rangeStart ? Date.parse(`${rangeStart}T00:00:00Z`) - 86400_000 : -Infinity;
      const items: DiscoveredItem[] = [];
      let reachedOlder = false;
      for (const e of entries) {
        const ref = parseActivityRef(e);
        if (!ref) continue;
        // Defensive: if the API ignores date filters, stop once we are past the range.
        if (ref.startTime && ref.startTime.getTime() < rangeStartMs) {
          reachedOlder = true;
          continue;
        }
        items.push({
          externalId: ref.externalId,
          activityType: ref.type,
          startTime: ref.startTime,
          name: ref.name,
          raw: ref.raw,
          status: isRunningType(ref.type) ? "discovered" : "skipped_type",
        });
      }
      return { items, count: entries.length, reachedOlder };
    },
    async download(id) {
      return (await garmin.downloadOriginalFit(id)).bytes;
    },
    parse: parseFitActivity,
    classifyError(e) {
      if (e instanceof GarminAuthError) return "auth";
      if (e instanceof GarminNotFoundError || e instanceof NotFitError) return "unavailable";
      if (e instanceof FitParseError) return "permanent";
      return "retry";
    },
  };
}

export interface TickContext {
  repo: IngestRepo;
  /** Either a source, or (legacy/tests) a Garmin client that is wrapped as one. */
  source?: ActivitySource;
  garmin?: GarminLike;
  now?: () => Date;
  /** epoch ms after which no new unit of work is started */
  deadline: number;
}

export interface TickResult {
  job: SyncJob | null;
  counters: JobCounters | null;
  processedThisTick: number;
  done: boolean;
  authError?: string;
  /** The source asked to stop for now (rate limit); the next tick continues. */
  paused?: string;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

export function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** attempts, 24 * 3600_000);
}

/** Creates an incremental job unless one is already active. */
export async function ensureIncrementalJob(repo: IngestRepo, now: Date): Promise<SyncJob> {
  const active = await repo.getActiveJob();
  if (active) return active;
  const latest = await repo.latestActivityStart();
  const from = latest ? addDays(latest, -INCREMENTAL_OVERLAP_DAYS) : addDays(now, -INCREMENTAL_DEFAULT_LOOKBACK_DAYS);
  return repo.createJob("incremental", isoDate(from), isoDate(addDays(now, 1)));
}

export async function startHistoricalImport(repo: IngestRepo, fromDate: string, now: Date): Promise<SyncJob> {
  const active = await repo.getActiveJob();
  if (active?.kind === "historical") return active;
  if (active) await repo.updateJob(active.id, { status: "cancelled", finished: true, lastError: "Superseded by historical import" });
  return repo.createJob("historical", fromDate, isoDate(addDays(now, 1)));
}

function sourceOf(ctx: TickContext): ActivitySource {
  if (ctx.source) return ctx.source;
  if (ctx.garmin) return garminSource(ctx.garmin);
  throw new Error("TickContext needs a source");
}

async function discoverPage(ctx: TickContext, job: SyncJob): Promise<boolean> {
  const offset = job.cursor.offset ?? 0;
  const source = sourceOf(ctx);
  let page;
  try {
    page = await source.listPage({ offset, limit: PAGE_SIZE, rangeStart: job.rangeStart, rangeEnd: job.rangeEnd });
  } catch (e) {
    const cls = source.classifyError(e);
    if (cls === "auth") throw new SourceAuthError(e instanceof Error ? e.message : String(e));
    if (cls === "stop") throw new StopTick(e instanceof Error ? e.message : String(e));
    throw e;
  }
  await ctx.repo.insertDiscovered(page.items, job.id);
  const done = page.count < PAGE_SIZE || page.reachedOlder;
  job.cursor = { offset: offset + page.count, discoveryDone: done };
  await ctx.repo.updateJob(job.id, { cursor: job.cursor, status: done ? "processing" : "discovering" });
  return done;
}

/** Process one raw source. Returns false if processing must stop (auth failure). */
export async function processOne(ctx: TickContext, raw: RawSourceRow): Promise<void> {
  const now = ctx.now?.() ?? new Date();
  const { repo } = ctx;
  const source = sourceOf(ctx);
  try {
    let bytes: Uint8Array;
    if (raw.filePath) {
      bytes = await repo.loadFile(raw.filePath);
    } else {
      bytes = await source.download(raw.externalId);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const path = `${source.name}/${raw.externalId}/${sha}.${source.fileExt}`;
      await repo.storeFile(path, bytes);
      await repo.updateRaw(raw.id, { status: "downloaded", filePath: path, fileSha256: sha, fileBytes: bytes.length, fetchedAt: now });
      raw = { ...raw, filePath: path, status: "downloaded" };
    }

    const activity = source.parse(bytes);
    if (!RUN_SPORTS.has(activity.sport)) {
      await repo.updateRaw(raw.id, { status: "skipped_type", lastError: `Sport is ${activity.sport}`, processedAt: now });
      return;
    }
    const derived = deriveActivity(activity);
    const candidates = await repo.findDuplicateCandidates(activity.startTime, raw.id);
    const dup = findDuplicate(
      { startTime: activity.startTime, elapsedS: derived.summary.elapsedS, distanceM: derived.summary.distanceM },
      candidates,
    );
    if (dup) {
      await repo.updateRaw(raw.id, { status: "duplicate", lastError: `Duplicate of activity ${dup.id}`, processedAt: now });
      return;
    }
    await repo.saveActivity(raw, activity, derived);
    await repo.updateRaw(raw.id, { status: "processed", lastError: null, processedAt: now });
  } catch (e) {
    const cls = source.classifyError(e);
    if (cls === "auth") throw new SourceAuthError(e instanceof Error ? e.message : String(e));
    if (cls === "stop") throw new StopTick(e instanceof Error ? e.message : String(e));
    if (cls === "unavailable") {
      await repo.updateRaw(raw.id, { status: "unavailable", lastError: e instanceof Error ? e.message : String(e), processedAt: now });
      return;
    }
    const attempts = raw.attempts + 1;
    const permanent = cls === "permanent";
    await repo.updateRaw(raw.id, {
      status: "failed",
      attempts: permanent ? MAX_ATTEMPTS : attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      lastError: sanitizeError(e),
    });
  }
}

export function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // never persist anything that looks like a credential
  return msg.replace(/(ApiKey|Bearer)\s+[^\s"']+/gi, "$1 [redacted]").slice(0, 500);
}

export async function runSyncTick(ctx: TickContext, opts: { createIncremental?: boolean } = {}): Promise<TickResult> {
  const now = () => ctx.now?.() ?? new Date();
  const { repo } = ctx;
  let job = await repo.getActiveJob();
  if (!job && opts.createIncremental) job = await ensureIncrementalJob(repo, now());
  let processedThisTick = 0;

  try {
    if (job && job.status === "queued") {
      await repo.updateJob(job.id, { status: "discovering", started: true });
      job.status = "discovering";
    }
    while (job && !job.cursor.discoveryDone && Date.now() < ctx.deadline) {
      await discoverPage(ctx, job);
    }
    while (Date.now() < ctx.deadline) {
      const batch = await repo.claimPending(5, now(), MAX_ATTEMPTS);
      if (batch.length === 0) break;
      for (const raw of batch) {
        if (Date.now() >= ctx.deadline) break;
        await processOne(ctx, raw);
        processedThisTick++;
      }
    }
  } catch (e) {
    if (e instanceof SourceAuthError || e instanceof GarminAuthError) {
      if (job) await repo.updateJob(job.id, { lastError: e.message });
      return { job, counters: job ? await repo.countForJob(job.id, MAX_ATTEMPTS) : null, processedThisTick, done: false, authError: e.message };
    }
    if (e instanceof StopTick) {
      if (job) await repo.updateJob(job.id, { lastError: e.message });
      return { job, counters: job ? await repo.countForJob(job.id, MAX_ATTEMPTS) : null, processedThisTick, done: false, paused: e.message };
    }
    if (job) await repo.updateJob(job.id, { lastError: sanitizeError(e) });
    throw e;
  }

  if (!job) return { job: null, counters: null, processedThisTick, done: true };
  const counters = await repo.countForJob(job.id, MAX_ATTEMPTS);
  const done = !!job.cursor.discoveryDone && counters.pending === 0;
  await repo.updateJob(job.id, {
    counters,
    ...(done ? { status: "completed" as const, finished: true } : {}),
  });
  return { job: { ...job, status: done ? "completed" : job.status }, counters, processedThisTick, done };
}
