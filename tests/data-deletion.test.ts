import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { KEEP_FOR_TRAINING, deleteUserData, keepFor, listAllFiles, removeFiles } from "@/lib/privacy/delete";

/** In-memory stand-in for Supabase Storage: list() returns direct children, folders without an id. */
function fakeStorage(paths: string[], opts: { failRemove?: boolean } = {}) {
  const files = new Set(paths);
  const removed: string[][] = [];
  const bucket = {
    list: async (dir: string, o: { limit: number; offset: number }) => {
      const children = new Map<string, boolean>();
      for (const p of files) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1);
        const [head, ...tail] = rest.split("/");
        children.set(head, children.get(head) || tail.length > 0);
      }
      const items = [...children.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, isDir]) => ({ name, id: isDir ? null : `id-${name}` }));
      return { data: items.slice(o.offset, o.offset + o.limit), error: null };
    },
    remove: async (chunk: string[]) => {
      if (opts.failRemove) return { data: null, error: { message: "boom" } };
      removed.push(chunk);
      chunk.forEach((p) => files.delete(p));
      return { data: chunk, error: null };
    },
  };
  return { storage: { from: () => bucket } as unknown as SupabaseClient["storage"], files, removed };
}

describe("data deletion", () => {
  it("keeps profile, Garmin connection and calendar link only for a training-data delete", () => {
    expect(keepFor("training")).toEqual(KEEP_FOR_TRAINING);
    expect(KEEP_FOR_TRAINING).toEqual(["athlete_profile", "integrations", "calendar_feeds"]);
    expect(keepFor("everything")).toEqual([]);
  });

  it("finds every file under the user's folder, including nested ones, and nothing else", async () => {
    const { storage } = fakeStorage(["u1/garmin/1.fit", "u1/garmin/2.fit", "u1/upload/x/3.fit", "u1/top.fit", "u2/garmin/9.fit"]);
    expect((await listAllFiles(storage, "b", "u1")).sort()).toEqual(["u1/garmin/1.fit", "u1/garmin/2.fit", "u1/top.fit", "u1/upload/x/3.fit"]);
  });

  it("pages through large folders", async () => {
    const many = Array.from({ length: 2345 }, (_, i) => `u1/garmin/${String(i).padStart(5, "0")}.fit`);
    const { storage } = fakeStorage(many);
    expect(await listAllFiles(storage, "b", "u1")).toHaveLength(2345);
  });

  it("removes files in chunks of 100", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `u1/f${i}`);
    const { storage, removed, files } = fakeStorage(paths);
    expect(await removeFiles(storage, "b", paths)).toBe(250);
    expect(removed.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(files.size).toBe(0);
  });

  function fakeDb(storage: SupabaseClient["storage"], settings: Record<string, unknown>) {
    const calls: { rpc?: [string, unknown]; update?: unknown } = {};
    const db = {
      storage,
      rpc: async (name: string, args: unknown) => {
        calls.rpc = [name, args];
        return { data: { activities: 3, wellness_daily: 10 }, error: null };
      },
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          update: (v: unknown) => {
            calls.update = v;
            return q;
          },
          then: (res: (v: unknown) => void) => res({ data: [{ id: "i1", settings }], error: null }),
        };
        return q;
      },
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it("deletes rows via the database function, resets sync bookkeeping, then removes files", async () => {
    const { storage, files } = fakeStorage(["u1/garmin/1.fit", "u2/garmin/2.fit"]);
    const { db, calls } = fakeDb(storage, { wellnessBackfillFrom: "2025-01-01", lastWellnessSyncAt: "x", lastScheduledRunAt: "y" });
    const r = await deleteUserData(db, "u1", "training");
    expect(calls.rpc).toEqual(["delete_user_data", { p_user: "u1", p_keep: KEEP_FOR_TRAINING }]);
    expect(calls.update).toEqual({ settings: { lastScheduledRunAt: "y" }, last_success_at: null });
    expect(r).toEqual({ rows: { activities: 3, wellness_daily: 10 }, files: 1, fileError: null });
    expect([...files]).toEqual(["u2/garmin/2.fit"]);
  });

  it("reports file-removal failures without hiding that the rows are gone", async () => {
    const { storage } = fakeStorage(["u1/a.fit"], { failRemove: true });
    const { db, calls } = fakeDb(storage, {});
    const r = await deleteUserData(db, "u1", "everything");
    expect(calls.rpc).toEqual(["delete_user_data", { p_user: "u1", p_keep: [] }]);
    expect(calls.update).toBeUndefined();
    expect(r.files).toBe(0);
    expect(r.fileError).toContain("boom");
  });
});
