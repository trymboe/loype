import { describe, expect, it } from "vitest";
import { revealHighlights, type RevealRunLike } from "@/lib/reveal";

const r = (id: string, date: string, km: number, paceSec = 360): RevealRunLike => ({
  id,
  local_date: date,
  distance_m: km * 1000,
  avg_speed_moving: 1000 / paceSec,
  moving_s: km * paceSec,
});

describe("revealHighlights", () => {
  const prior = [r("a", "2026-08-10", 8), r("b", "2026-09-01", 6), r("c", "2026-10-01", 5), r("d", "2026-10-28", 5)];

  it("calls out the longest run since the last one at least as long", () => {
    const hs = revealHighlights(r("x", "2026-11-02", 9), prior, "2026-08-04", "2026-11-02");
    expect(hs.map((h) => h.text)).toContain("Longest run in 3 months");
  });

  it("does not overclaim when a longer run was recent", () => {
    const hs = revealHighlights(r("x", "2026-11-02", 5.5), [...prior, r("e", "2026-10-25", 7)], "2026-08-04", "2026-11-02");
    expect(hs.some((h) => h.kind === "longest")).toBe(false);
  });

  it("ignores short runs for fastest pace and needs enough history", () => {
    expect(revealHighlights(r("x", "2026-11-02", 2, 280), prior, "2026-08-04", "2026-11-02").some((h) => h.kind === "fastest")).toBe(false);
    expect(revealHighlights(r("x", "2026-11-02", 5, 300), prior, "2026-08-04", "2026-11-02").some((h) => h.kind === "fastest")).toBe(true);
    expect(revealHighlights(r("x", "2026-11-02", 9, 300), prior.slice(0, 2), "2026-08-04", "2026-11-02").length).toBe(1);
  });

  it("summarises the week including this run", () => {
    const hs = revealHighlights(r("x", "2026-11-04", 5), [...prior, r("e", "2026-11-02", 4)], "2026-08-04", "2026-11-02");
    expect(hs.find((h) => h.kind === "week")?.text).toBe("2nd run this week · 9.0 km");
  });
});
