import { describe, expect, it } from "vitest";
import {
  DEFAULT_EASY_PACE,
  distanceTolerance,
  easyPaceFromSteps,
  loopPlannerHref,
  parsePlannerParams,
  prefersFlat,
  suggestRoutes,
  targetDistance,
  type SuggestRoute,
} from "@/lib/routes/suggest";
import { flatScore } from "@/lib/routes/flat-loop";
import type { Step, Target } from "@/lib/planning/types";

const today = "2026-11-07";
const t = (zone: Target["zone"], paceFast: number | null, paceSlow: number | null): Target => ({ zone, paceFast, paceSlow, hrMin: null, hrMax: null, label: zone });
const route = (id: string, km: number, gain: number | null, extra: Partial<SuggestRoute> = {}): SuggestRoute => ({ id, distanceM: km * 1000, elevationGainM: gain, favorite: false, ...extra });

describe("target distance", () => {
  it("uses the planned distance when there is one", () => {
    expect(targetDistance({ type: "easy", durationS: 3600, distanceM: 9500 })).toBe(9500);
  });

  it("estimates from duration at the easy pace in the steps", () => {
    const steps: Step[] = [{ kind: "run", durationS: 3000, target: t("easy", 330, 370) }];
    expect(easyPaceFromSteps(steps)).toBe(350);
    expect(targetDistance({ type: "easy", durationS: 3500, distanceM: null, steps })).toBeCloseTo(10_000);
  });

  it("finds the easy pace inside repeats and falls back to a default", () => {
    const steps: Step[] = [{ kind: "repeat", count: 4, steps: [{ kind: "run", durationS: 300, target: t("threshold", 280, 290) }, { kind: "recover", durationS: 90, target: t("recovery", 400, 440) }] }];
    expect(easyPaceFromSteps(steps)).toBe(420);
    expect(targetDistance({ type: "long", durationS: DEFAULT_EASY_PACE * 12, distanceM: null })).toBeCloseTo(12_000);
    expect(targetDistance({ type: "easy", durationS: 3000, distanceM: null }, 300)).toBeCloseTo(10_000);
    expect(targetDistance({ type: "easy", durationS: 0, distanceM: null })).toBeNull();
  });
});

describe("suggestRoutes", () => {
  it("keeps routes within the distance tolerance only", () => {
    expect(distanceTolerance(5000)).toBe(1000);
    expect(distanceTolerance(20_000)).toBe(3000);
    const out = suggestRoutes({ type: "easy", durationS: null, distanceM: 10_000 }, [route("a", 10.4, 40), route("b", 12, 10), route("c", 7, 0), route("d", 9, 60)], { today });
    expect(out.map((r) => r.route.id).sort()).toEqual(["a", "d"]);
  });

  it("prefers flat routes for quality sessions", () => {
    const routes = [route("hilly", 10, 200), route("flat", 10.8, 20)];
    expect(suggestRoutes({ type: "threshold", durationS: null, distanceM: 10_000 }, routes, { today })[0].route.id).toBe("flat");
    expect(suggestRoutes({ type: "time_trial", durationS: null, distanceM: 10_000 }, routes, { today })[0].route.id).toBe("flat");
    expect(prefersFlat("tempo")).toBe(true);
    expect(prefersFlat("easy")).toBe(false);
    expect(prefersFlat("hills")).toBe(false);
  });

  it("lets easy and long runs go hilly and ranks by fit first", () => {
    const routes = [route("hilly", 10, 200), route("flat", 10.8, 20)];
    expect(suggestRoutes({ type: "easy", durationS: null, distanceM: 10_000 }, routes, { today })[0].route.id).toBe("hilly");
    expect(suggestRoutes({ type: "long", durationS: null, distanceM: 10_000 }, routes, { today })[0].route.id).toBe("hilly");
  });

  it("breaks near-ties with favourites and recent use", () => {
    const w = { type: "easy", durationS: null, distanceM: 8000 };
    const routes = [route("plain", 8, 30), route("fav", 8.1, 30, { favorite: true }), route("recent", 8.1, 30, { lastUsed: "2026-11-01" }), route("old", 8.1, 30, { lastUsed: "2025-01-01" })];
    const ids = suggestRoutes(w, routes, { today, limit: 4 }).map((r) => r.route.id);
    expect(ids.slice(0, 2)).toEqual(["fav", "recent"]);
    expect(ids.indexOf("plain")).toBeLessThan(ids.indexOf("old"));
  });

  it("returns at most the limit, and nothing for rest or races", () => {
    const routes = Array.from({ length: 6 }, (_, i) => route(`r${i}`, 6 + i * 0.1, 10));
    expect(suggestRoutes({ type: "easy", durationS: null, distanceM: 6000 }, routes, { today })).toHaveLength(3);
    expect(suggestRoutes({ type: "race", durationS: null, distanceM: 6000 }, routes, { today })).toEqual([]);
    expect(suggestRoutes({ type: "rest", durationS: 0, distanceM: null }, routes, { today })).toEqual([]);
  });

  it("reports climb per km", () => {
    const [r] = suggestRoutes({ type: "easy", durationS: null, distanceM: 10_000 }, [route("a", 10, 50)], { today });
    expect(r.climbPerKm).toBe(5);
    const [u] = suggestRoutes({ type: "easy", durationS: null, distanceM: 10_000 }, [route("u", 10, null)], { today });
    expect(u.climbPerKm).toBeNull();
  });
});

describe("planner params", () => {
  it("builds and parses the loop link", () => {
    expect(loopPlannerHref(8240, true)).toBe("/routes/new?mode=loop&km=8&flat=1");
    expect(loopPlannerHref(12_300, false)).toBe("/routes/new?mode=loop&km=12.5");
    expect(loopPlannerHref(60_000, false)).toBe("/routes/new?mode=loop&km=30");
    expect(parsePlannerParams({ mode: "loop", km: "8", flat: "1" })).toEqual({ mode: "loop", km: 8, flat: true });
    expect(parsePlannerParams({ km: "12.3" })).toEqual({ mode: "loop", km: 12.5, flat: false });
    expect(parsePlannerParams({ km: "abc" })).toEqual({ mode: null, km: null, flat: false });
    expect(parsePlannerParams({ km: "99", flat: ["1"] })).toEqual({ mode: null, km: null, flat: true });
  });
});

describe("flat loop score", () => {
  it("prefers less climbing and penalises far-off distances", () => {
    expect(flatScore(10_000, 10_000, 30)).toBeLessThan(flatScore(10_000, 10_000, 120));
    expect(flatScore(13_000, 10_000, 0)).toBeGreaterThan(flatScore(10_000, 10_000, 60));
    expect(flatScore(10_000, 10_000, null)).toBe(20);
  });
});
