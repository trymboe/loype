import { describe, expect, it } from "vitest";
import { replacedIds, stillNeeded } from "../src/lib/planning/replaced";
import { adherence } from "../src/lib/planning/projection";

describe("replacedIds", () => {
  it("treats a skipped run with a coach-added one in the same week as rescheduled", () => {
    const ids = replacedIds([
      { id: "sat", date: "2026-11-14", type: "easy", status: "skipped", source: "generator" },
      { id: "sun", date: "2026-11-15", type: "easy", status: "completed", source: "athlete" },
    ]);
    expect([...ids]).toEqual(["sat"]);
  });

  it("keeps plain skipped and missed runs", () => {
    const ids = replacedIds([
      { id: "a", date: "2026-11-16", type: "threshold", status: "missed", source: "generator" },
      // a different kind of session doesn't replace it
      { id: "b", date: "2026-11-17", type: "easy", status: "completed", source: "athlete" },
      // the generator's own runs don't replace anything
      { id: "c", date: "2026-11-18", type: "easy", status: "skipped", source: "generator" },
      { id: "d", date: "2026-11-19", type: "easy", status: "completed", source: "generator" },
      // nor do runs in another week
      { id: "e", date: "2026-11-23", type: "threshold", status: "completed", source: "athlete" },
    ]);
    // b replaces c (same kind, same week); a has no replacement
    expect([...ids]).toEqual(["c"]);
  });

  it("lets one replacement cover one cancelled run", () => {
    const ids = replacedIds([
      { id: "a", date: "2026-11-16", type: "easy", status: "missed", source: "generator" },
      { id: "b", date: "2026-11-17", type: "easy", status: "missed", source: "generator" },
      { id: "c", date: "2026-11-18", type: "strides", status: "completed", source: "athlete" },
    ]);
    expect(ids.size).toBe(1);
  });

  it("doesn't count a rescheduled run against adherence", () => {
    const ws = [
      { id: "a", date: "2026-11-16", type: "strides", status: "missed", source: "generator" },
      { id: "b", date: "2026-11-17", type: "strides", status: "completed", source: "athlete" },
      { id: "c", date: "2026-11-20", type: "easy", status: "completed", source: "athlete" },
      { id: "d", date: "2026-11-22", type: "long", status: "completed", source: "athlete" },
    ];
    expect(adherence(ws, "2026-11-23", "2026-10-26")).toBe(1);
    expect(adherence(ws.map((w) => ({ ...w, source: "generator" })), "2026-11-23", "2026-10-26")).toBe(0.75);
  });
});

describe("stillNeeded", () => {
  it("doesn't plan a moved run again on the day it was moved from", () => {
    const generated = [
      { date: "2026-11-16", type: "strides" },
      { date: "2026-11-18", type: "threshold" },
      { date: "2026-11-20", type: "easy" },
      { date: "2026-11-22", type: "long" },
    ];
    const kept = [
      { date: "2026-11-17", type: "strides" },
      { date: "2026-11-21", type: "long" },
    ];
    expect(stillNeeded(generated, kept).map((g) => g.date)).toEqual(["2026-11-18", "2026-11-20"]);
  });

  it("drops what falls on a kept day without taking a second one", () => {
    const generated = [
      { date: "2026-11-17", type: "easy" },
      { date: "2026-11-19", type: "easy" },
    ];
    expect(stillNeeded(generated, [{ date: "2026-11-17", type: "easy" }]).map((g) => g.date)).toEqual(["2026-11-19"]);
  });

  it("leaves other weeks alone", () => {
    const generated = [{ date: "2026-11-24", type: "strides" }];
    expect(stillNeeded(generated, [{ date: "2026-11-17", type: "strides" }])).toHaveLength(1);
  });
});
