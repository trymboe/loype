import { describe, expect, it } from "vitest";
import { chooseLongRunDay, pickQualityDays, spreadDays } from "../src/lib/planning/generator";

const week = (avail: number[], runs: number, hard: number, habit: number | null = null) => {
  const d = chooseLongRunDay(avail, runs, hard, habit);
  const days = spreadDays(avail, runs, d);
  return { d, days, q: pickQualityDays(days, d, hard) };
};

describe("best-fit long-run day", () => {
  it("is always one of the days you can run", () => {
    for (const avail of [[1, 3], [0, 2, 4], [1, 2, 3], [0, 1, 2, 3, 4], [2, 5]]) expect(avail).toContain(chooseLongRunDay(avail, avail.length, 1));
  });

  it("leaves the day after it free and keeps hard sessions 2+ days away", () => {
    const { d, days, q } = week([0, 1, 2, 3, 4, 5, 6], 3, 1);
    expect(days).not.toContain((d + 1) % 7);
    expect(q).toHaveLength(1);
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
    expect(gap(q[0], d)).toBeGreaterThanOrEqual(2);
  });

  it("with every day open and nothing else to choose between, it lands on the weekend", () => {
    expect([5, 6]).toContain(chooseLongRunDay([0, 1, 2, 3, 4, 5, 6], 3, 1));
    expect([5, 6]).toContain(chooseLongRunDay([0, 1, 2, 3, 4, 5, 6], 4, 2));
  });

  it("fits two hard sessions with 4 runs", () => {
    const { q } = week([0, 1, 2, 3, 4, 5, 6], 4, 2);
    expect(q).toHaveLength(2);
  });

  it("avoids a day right after another run when there is a choice", () => {
    // Mon, Tue, Thu: a long run Tue would follow Mon's run and sit right before nothing; Thu has rest on both sides after Tue
    const d = chooseLongRunDay([0, 1, 3], 3, 1);
    expect(d).not.toBe(0);
  });

  it("uses the day of your longest recent run as a tie-break", () => {
    expect(chooseLongRunDay([1, 3, 5], 2, 0, 1)).toBe(1);
  });
});
