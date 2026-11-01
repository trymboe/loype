import { describe, expect, it } from "vitest";
import { runSyncTick, startHistoricalImport, ensureIncrementalJob, MAX_ATTEMPTS, type GarminLike } from "@/lib/ingest/engine";
import { MemoryIngestRepo } from "@/lib/ingest/memory-repo";
import { GarminAuthError, GarminError, GarminNotFoundError } from "@/lib/integrations/garmin/client";
import { buildFit } from "./fit-builder";

interface FakeActivity {
  id: number;
  start: Date;
  type?: string;
  file?: Uint8Array | "missing" | "corrupt" | "flaky";
}

function fakeGarmin(acts: FakeActivity[]) {
  const calls = { list: 0, download: 0 };
  const flaky = new Map<string, number>();
  const g: GarminLike = {
    async listActivities({ start, limit, startDate, endDate }) {
      calls.list++;
      const lo = startDate ? Date.parse(`${startDate}T00:00:00Z`) : -Infinity;
      const hi = endDate ? Date.parse(`${endDate}T23:59:59Z`) : Infinity;
      const sorted = acts
        .filter((a) => a.start.getTime() >= lo && a.start.getTime() <= hi)
        .sort((a, b) => b.start.getTime() - a.start.getTime());
      return sorted.slice(start, start + limit).map((a) => ({
        activityId: a.id,
        activityName: `Run ${a.id}`,
        startTimeGMT: a.start.toISOString().slice(0, 19).replace("T", " "),
        activityType: { typeKey: a.type ?? "running" },
      }));
    },
    async downloadOriginalFit(id) {
      calls.download++;
      const a = acts.find((x) => String(x.id) === id)!;
      if (a.file === "missing") throw new GarminNotFoundError("gone", 404);
      if (a.file === "corrupt") return { bytes: new TextEncoder().encode("garbage-not-fit-at-all"), filename: "x.fit" };
      if (a.file === "flaky") {
        const n = (flaky.get(id) ?? 0) + 1;
        flaky.set(id, n);
        if (n === 1) throw new GarminError("HTTP 503", 503, true);
      }
      const bytes = a.file instanceof Uint8Array ? a.file : buildFit({ start: a.start, segments: [{ durationS: 900, speedMs: 3, hr: 145 }] });
      return { bytes, filename: `${id}.fit` };
    },
  };
  return { g, calls };
}

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 6, 0, 0));
const NOW = new Date(Date.UTC(2026, 10, 1, 12));
const ctx = (repo: MemoryIngestRepo, g: GarminLike, now = NOW) => ({ repo, garmin: g, now: () => now, deadline: Date.now() + 20_000 });

describe("historical import", () => {
  it("imports all runs across pages, skips non-runs, and completes", async () => {
    const acts: FakeActivity[] = Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, start: day(i % 30), type: i % 10 === 0 ? "cycling" : "running" }));
    // make starts unique to avoid dedupe collisions
    acts.forEach((a, i) => (a.start = new Date(a.start.getTime() + i * 3600_000)));
    const repo = new MemoryIngestRepo();
    const { g } = fakeGarmin(acts);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    const r = await runSyncTick(ctx(repo, g));
    expect(r.done).toBe(true);
    expect(r.counters).toMatchObject({ discovered: 60, processed: 54, skipped: 6, failed: 0, pending: 0 });
    expect(repo.activities).toHaveLength(54);
  });

  it("is idempotent: re-running discovery does not duplicate activities", async () => {
    const acts = [{ id: 1, start: day(1) }, { id: 2, start: day(2) }];
    const repo = new MemoryIngestRepo();
    const { g, calls } = fakeGarmin(acts);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    await runSyncTick(ctx(repo, g));
    await ensureIncrementalJob(repo, NOW);
    await runSyncTick(ctx(repo, g));
    expect(repo.activities).toHaveLength(2);
    expect(calls.download).toBe(2);
  });

  it("resumes when a tick runs out of time", async () => {
    const acts = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, start: day(i) }));
    const repo = new MemoryIngestRepo();
    const { g } = fakeGarmin(acts);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    const first = await runSyncTick({ ...ctx(repo, g), deadline: Date.now() - 1 }); // no time at all
    expect(first.done).toBe(false);
    const second = await runSyncTick(ctx(repo, g));
    expect(second.done).toBe(true);
    expect(repo.activities).toHaveLength(8);
  });
});

describe("failure handling", () => {
  it("marks missing originals unavailable and corrupt files failed without retrying them", async () => {
    const acts: FakeActivity[] = [
      { id: 1, start: day(1) },
      { id: 2, start: day(2), file: "missing" },
      { id: 3, start: day(3), file: "corrupt" },
    ];
    const repo = new MemoryIngestRepo();
    const { g } = fakeGarmin(acts);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    const r = await runSyncTick(ctx(repo, g));
    expect(r.counters).toMatchObject({ processed: 1, unavailable: 1, failed: 1, pending: 0 });
    const corrupt = repo.raws.find((x) => x.externalId === "3")!;
    expect(corrupt.attempts).toBe(MAX_ATTEMPTS);
  });

  it("retries transient errors with backoff and succeeds later", async () => {
    const repo = new MemoryIngestRepo();
    const { g } = fakeGarmin([{ id: 9, start: day(5), file: "flaky" }]);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    await runSyncTick(ctx(repo, g));
    const raw = repo.raws[0];
    expect(raw.status).toBe("failed");
    expect(raw.attempts).toBe(1);
    // not retried before the backoff has elapsed
    await runSyncTick(ctx(repo, g, new Date(NOW.getTime() + 60_000)));
    expect(repo.raws[0].status).toBe("failed");
    await runSyncTick(ctx(repo, g, new Date(NOW.getTime() + 11 * 60_000)));
    expect(repo.raws[0].status).toBe("processed");
  });

  it("stops and reports auth errors instead of marking activities failed", async () => {
    const repo = new MemoryIngestRepo();
    const g: GarminLike = {
      async listActivities() {
        throw new GarminAuthError("key expired", 401);
      },
      async downloadOriginalFit() {
        throw new Error("unreachable");
      },
    };
    await startHistoricalImport(repo, "2026-09-01", NOW);
    const r = await runSyncTick(ctx(repo, g));
    expect(r.authError).toMatch(/key expired/);
    expect(r.done).toBe(false);
  });
});

describe("incremental sync", () => {
  it("looks back from the latest activity with overlap, recovering missed periods", async () => {
    const repo = new MemoryIngestRepo();
    const { g } = fakeGarmin([{ id: 1, start: day(1) }]);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    await runSyncTick(ctx(repo, g));
    const job = await ensureIncrementalJob(repo, NOW);
    expect(job.rangeStart).toBe("2026-09-29"); // latest run Oct 2 minus 3 days overlap
    expect(job.rangeEnd).toBe("2026-11-02");
  });

  it("detects the same run arriving under a different id as a duplicate", async () => {
    const repo = new MemoryIngestRepo();
    const bytes = buildFit({ start: day(3), segments: [{ durationS: 900, speedMs: 3, hr: 145 }] });
    const { g } = fakeGarmin([
      { id: 1, start: day(3), file: bytes },
      { id: 2, start: new Date(day(3).getTime() + 30_000), file: bytes },
    ]);
    await startHistoricalImport(repo, "2026-09-01", NOW);
    const r = await runSyncTick(ctx(repo, g));
    expect(repo.activities).toHaveLength(1);
    expect(r.counters?.skipped).toBe(1);
    expect(repo.raws.some((x) => x.status === "duplicate")).toBe(true);
  });
});
