import type { DedupeCandidate } from "../analytics/dedupe";
import type { IngestRepo, JobCounters, JobKind, RawSourceRow, SyncJob, WellnessObservation } from "./types";

/** In-memory IngestRepo used by tests (and handy for local experiments). */
export class MemoryIngestRepo implements IngestRepo {
  jobs: (SyncJob & { lastError?: string | null; counters?: JobCounters })[] = [];
  raws: (RawSourceRow & { nextAttemptAt: Date; lastError?: string | null; raw: unknown })[] = [];
  files = new Map<string, Uint8Array>();
  activities: { id: string; rawId: string; startTime: Date; elapsedS: number | null; distanceM: number | null }[] = [];
  wellness = new Map<string, WellnessObservation>();
  private seq = 0;
  private id = (p: string) => `${p}-${++this.seq}`;

  async getActiveJob() {
    return this.jobs.find((j) => ["queued", "discovering", "processing"].includes(j.status)) ?? null;
  }
  async getLastJob(kind: JobKind) {
    return [...this.jobs].reverse().find((j) => j.kind === kind) ?? null;
  }
  async createJob(kind: JobKind, rangeStart: string | null, rangeEnd: string | null) {
    const job: SyncJob = { id: this.id("job"), kind, status: "queued", rangeStart, rangeEnd, cursor: {}, createdAt: new Date() };
    this.jobs.push(job);
    return { ...job };
  }
  async updateJob(id: string, patch: Parameters<IngestRepo["updateJob"]>[1]) {
    const j = this.jobs.find((x) => x.id === id)!;
    if (patch.status) j.status = patch.status;
    if (patch.cursor) j.cursor = { ...patch.cursor };
    if (patch.lastError !== undefined) j.lastError = patch.lastError;
    if (patch.counters) j.counters = patch.counters;
  }
  async countForJob(jobId: string): Promise<JobCounters> {
    const rs = this.raws.filter((r) => r.syncJobId === jobId);
    const c = (s: string[]) => rs.filter((r) => s.includes(r.status)).length;
    return {
      discovered: rs.length,
      processed: c(["processed"]),
      failed: c(["failed"]),
      unavailable: c(["unavailable"]),
      skipped: c(["skipped_type", "duplicate"]),
      pending: c(["discovered", "downloaded"]),
    };
  }
  async insertDiscovered(items: Parameters<IngestRepo["insertDiscovered"]>[0], jobId: string) {
    let n = 0;
    for (const it of items) {
      if (this.raws.some((r) => r.externalId === it.externalId)) continue;
      this.raws.push({
        id: this.id("raw"),
        externalId: it.externalId,
        activityType: it.activityType,
        startTime: it.startTime,
        name: it.name,
        status: it.status,
        attempts: 0,
        filePath: null,
        syncJobId: jobId,
        nextAttemptAt: new Date(0),
        raw: it.raw,
      });
      n++;
    }
    return n;
  }
  async claimPending(limit: number, now: Date, maxAttempts: number) {
    return this.raws
      .filter(
        (r) =>
          (["discovered", "downloaded"].includes(r.status) || (r.status === "failed" && r.attempts < maxAttempts)) &&
          r.nextAttemptAt.getTime() <= now.getTime(),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async updateRaw(id: string, patch: Parameters<IngestRepo["updateRaw"]>[1]) {
    const r = this.raws.find((x) => x.id === id)!;
    if (patch.status) r.status = patch.status;
    if (patch.attempts != null) r.attempts = patch.attempts;
    if (patch.nextAttemptAt) r.nextAttemptAt = patch.nextAttemptAt;
    if (patch.lastError !== undefined) r.lastError = patch.lastError;
    if (patch.filePath) r.filePath = patch.filePath;
  }
  async storeFile(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async loadFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`missing file ${path}`);
    return f;
  }
  async latestActivityStart() {
    const ts = this.activities.map((a) => a.startTime.getTime());
    return ts.length ? new Date(Math.max(...ts)) : null;
  }
  async findDuplicateCandidates(start: Date, excludeRawId: string): Promise<(DedupeCandidate & { id: string })[]> {
    return this.activities.filter((a) => a.rawId !== excludeRawId && Math.abs(a.startTime.getTime() - start.getTime()) < 600_000);
  }
  async saveActivity(raw: RawSourceRow, activity: Parameters<IngestRepo["saveActivity"]>[1], derived: Parameters<IngestRepo["saveActivity"]>[2]) {
    const existing = this.activities.find((a) => a.rawId === raw.id);
    const row = {
      id: existing?.id ?? this.id("act"),
      rawId: raw.id,
      startTime: activity.startTime,
      elapsedS: derived.summary.elapsedS,
      distanceM: derived.summary.distanceM,
    };
    if (existing) Object.assign(existing, row);
    else this.activities.push(row);
    return row.id;
  }
  async saveWellness(obs: WellnessObservation[]) {
    for (const o of obs) this.wellness.set(`${o.calendarDate}:${o.metric}`, o);
    return obs.length;
  }
}
