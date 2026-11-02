import { describe, expect, it } from "vitest";
import { inRange, rangeStart } from "@/components/progress/chart-range";

describe("chart range", () => {
  it("1M covers the last 30 days including today", () => {
    expect(rangeStart("1m", "2026-11-02")).toBe("2026-10-04");
  });
  it("All has no start", () => {
    expect(rangeStart("all", "2026-11-02")).toBeNull();
  });
  it("filters by date, accepting ISO timestamps", () => {
    const pts = [{ d: "2026-09-01" }, { d: "2026-10-04T08:00:00Z" }, { d: "2026-11-01" }];
    expect(inRange(pts, "1m", "2026-11-02", (p) => p.d).map((p) => p.d)).toEqual(["2026-10-04T08:00:00Z", "2026-11-01"]);
    expect(inRange(pts, "all", "2026-11-02", (p) => p.d)).toHaveLength(3);
  });
});
