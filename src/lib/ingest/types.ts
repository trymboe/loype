import type { DerivedActivity } from "../analytics/summarize";
import type { DedupeCandidate } from "../analytics/dedupe";
import type { NormalizedActivity } from "../fit/types";

export type RawStatus = "discovered" | "downloaded" | "processed" | "failed" | "unavailable" | "skipped_type" | "duplicate";
export type JobKind = "historical" | "incremental" | "wellness" | "reprocess";
export type JobStatus = "queued" | "discovering" | "processing" | "completed" | "failed" | "cancelled";

export interface RawSourceRow {
  id: string;
  externalId: string;
  activityType: string | null;
  startTime: Date | null;
  name: string | null;
  status: RawStatus;
  attempts: number;
  filePath: string | null;
  syncJobId: string | null;
}

export interface SyncJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  rangeStart: string | null; // YYYY-MM-DD
  rangeEnd: string | null;
  cursor: { offset?: number; discoveryDone?: boolean };
  createdAt: Date;
}

export interface JobCounters {
  discovered: number;
  processed: number;
  failed: number;
  unavailable: number;
  skipped: number;
  pending: number;
}

export interface DiscoveredItem {
  externalId: string;
  activityType: string | null;
  startTime: Date | null;
  name: string | null;
  raw: unknown;
  status: "discovered" | "skipped_type";
}

export interface WellnessObservation {
  calendarDate: string;
  metric: string;
  value: number | null;
  unit: string | null;
  raw: unknown;
}

/** Persistence boundary of the ingestion engine (Supabase in prod, in-memory in tests). */
export interface IngestRepo {
  getActiveJob(): Promise<SyncJob | null>;
  getLastJob(kind: JobKind): Promise<SyncJob | null>;
  createJob(kind: JobKind, rangeStart: string | null, rangeEnd: string | null): Promise<SyncJob>;
  updateJob(id: string, patch: Partial<Pick<SyncJob, "status" | "cursor">> & { lastError?: string | null; counters?: JobCounters; finished?: boolean; started?: boolean }): Promise<void>;
  countForJob(jobId: string, maxAttempts: number): Promise<JobCounters>;

  /** Insert new items; existing (provider, external_id) rows are left untouched. Returns number inserted. */
  insertDiscovered(items: DiscoveredItem[], jobId: string): Promise<number>;
  claimPending(limit: number, now: Date, maxAttempts: number): Promise<RawSourceRow[]>;
  updateRaw(id: string, patch: {
    status?: RawStatus;
    attempts?: number;
    nextAttemptAt?: Date;
    lastError?: string | null;
    filePath?: string;
    fileSha256?: string;
    fileBytes?: number;
    fetchedAt?: Date;
    processedAt?: Date;
  }): Promise<void>;

  storeFile(path: string, bytes: Uint8Array): Promise<void>;
  loadFile(path: string): Promise<Uint8Array>;

  latestActivityStart(): Promise<Date | null>;
  findDuplicateCandidates(start: Date, excludeRawId: string): Promise<(DedupeCandidate & { id: string })[]>;
  saveActivity(raw: RawSourceRow, activity: NormalizedActivity, derived: DerivedActivity): Promise<string>;

  saveWellness(obs: WellnessObservation[]): Promise<number>;
}
