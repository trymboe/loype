import { describe, expect, it } from "vitest";
import { downsample, gainLoss, GpxError, parseGpx, type CoursePoint } from "@/lib/race/gpx";
import { gradeFactor, pacingPlan } from "@/lib/race/pacing";
import { predictRace, raceStatus, vdotFor } from "@/lib/race/status";
import { raceGoalFromRow } from "@/lib/race/goal";
import { predictTimeS } from "@/lib/analytics/fitness/vdot";

/** A straight course heading north: ~111 m per 0.001° latitude, with an elevation function of distance. */
function gpx(km: number, ele: (m: number) => number | null, tag = "trkpt") {
  const pts: string[] = [];
  const n = Math.round(km * 40); // ~25 m spacing
  for (let i = 0; i <= n; i++) {
    const lat = 59.9 + (i * (km / n)) / 111.195;
    const e = ele((i * km * 1000) / n);
    pts.push(`<${tag} lat="${lat.toFixed(7)}" lon="10.75">${e == null ? "" : `<ele>${e.toFixed(1)}</ele>`}</${tag}>`);
  }
  const wrap = tag === "trkpt" ? `<trk><name>Test &amp; race</name><trkseg>${pts.join("")}</trkseg></trk>` : `<rte><name>R</name>${pts.join("")}</rte>`;
  return `<?xml version="1.0"?><gpx version="1.1" creator="t">${wrap}</gpx>`;
}

describe("GPX parsing", () => {
  it("reads track points, distance, name and elevation", () => {
    const c = parseGpx(gpx(10, (m) => 100 + (m < 5000 ? m / 50 : (10_000 - m) / 50)));
    expect(c.name).toBe("Test & race");
    expect(c.distanceM).toBeGreaterThan(9950);
    expect(c.distanceM).toBeLessThan(10_050);
    expect(c.gainM).toBeGreaterThan(90);
    expect(c.gainM).toBeLessThan(105);
    expect(c.lossM).toBeGreaterThan(90);
    expect(c.points.length).toBeLessThanOrEqual(600);
    expect(c.points[0][3]).toBe(0);
  });

  it("falls back to route points and handles missing elevation", () => {
    const c = parseGpx(gpx(3, () => null, "rtept"));
    expect(c.distanceM).toBeGreaterThan(2950);
    expect(c.gainM).toBeNull();
    expect(c.points.every((p) => p[2] == null)).toBe(true);
  });

  it("ignores elevation noise when counting climb", () => {
    // flat course with ±1.5 m jitter on every point
    const c = parseGpx(gpx(5, (m) => 50 + (Math.round(m / 25) % 2 ? 1.5 : -1.5)));
    expect(c.gainM).toBeLessThan(5);
  });

  it("rejects files that aren't usable GPX", () => {
    expect(() => parseGpx("<html></html>")).toThrow(GpxError);
    expect(() => parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>')).toThrow(/No track/);
    expect(() => parseGpx(gpx(0.2, () => 0))).toThrow(/shorter/);
  });

  it("downsamples by distance and keeps the ends", () => {
    const pts: CoursePoint[] = Array.from({ length: 2000 }, (_, i) => [0, 0, i, i * 5]);
    const d = downsample(pts, 100);
    expect(d.length).toBeLessThanOrEqual(100);
    expect(d[0]).toBe(pts[0]);
    expect(d.at(-1)).toBe(pts.at(-1));
  });

  it("counts gain with hysteresis", () => {
    expect(gainLoss([0, 1, 0, 1, 0, 1]).gain).toBe(0);
    expect(gainLoss([0, 5, 10, 5]).gain).toBe(10);
    expect(gainLoss([0, 5, 10, 5]).loss).toBe(5);
  });
});

describe("pacing plan", () => {
  it("adds up to the finish time with even splits on a flat course", () => {
    const p = pacingPlan({ distanceM: 10_000, targetS: 2700, strategy: "even" });
    expect(p.splits).toHaveLength(10);
    expect(p.splits.at(-1)!.cumS).toBeCloseTo(2700, 5);
    for (const s of p.splits) expect(s.paceSPerKm).toBeCloseTo(270, 5);
    expect(p.usesCourse).toBe(false);
  });

  it("negative split: second half faster, total unchanged", () => {
    const p = pacingPlan({ distanceM: 21_097.5, targetS: 6600, strategy: "negative" });
    expect(p.splits).toHaveLength(22);
    expect(p.splits.at(-1)!.endM).toBeCloseTo(21_097.5);
    expect(p.splits.at(-1)!.cumS).toBeCloseTo(6600, 5);
    expect(p.secondHalfS).toBeLessThan(p.firstHalfS);
    // about 2 % between halves
    expect((p.firstHalfS - p.secondHalfS) / 3300).toBeGreaterThan(0.015);
    expect((p.firstHalfS - p.secondHalfS) / 3300).toBeLessThan(0.025);
    expect(p.checkpoints.map((c) => c.label)).toEqual(["5 km", "10 km", "Half way"]);
  });

  it("slows climbs and speeds descents on a hilly course", () => {
    const course = parseGpx(gpx(10, (m) => (m < 5000 ? 100 + m * 0.03 : 250 - (m - 5000) * 0.03))).points;
    const p = pacingPlan({ distanceM: 10_000, targetS: 3000, strategy: "even", course });
    expect(p.usesCourse).toBe(true);
    expect(p.splits.at(-1)!.cumS).toBeCloseTo(3000, 5);
    const up = p.splits[2];
    const down = p.splits[7];
    expect(up.gradePct!).toBeGreaterThan(2);
    expect(down.gradePct!).toBeLessThan(-2);
    expect(up.paceSPerKm).toBeGreaterThan(down.paceSPerKm);
    // uphill costs more than downhill returns, so flat-equivalent pace is faster than the average
    expect(p.flatPaceSPerKm).toBeLessThan(p.averagePaceSPerKm);
  });

  it("grade factor: uphill costs more than downhill gives back, steep descents stop helping", () => {
    expect(gradeFactor(0)).toBe(1);
    expect(gradeFactor(5) - 1).toBeGreaterThan(1 - gradeFactor(-5));
    expect(gradeFactor(-15)).toBeGreaterThan(gradeFactor(-8));
  });
});

describe("race status", () => {
  const est = { vdot: 45, lower: 43.5, upper: 46.5, confidence: "medium" as const };
  const goal = { name: "Oslo 10k", distanceM: 10_000, raceDate: "2027-04-24", targetTimeS: null as number | null };

  it("predicts from VDOT and applies the endurance penalty", () => {
    const fresh = predictRace(10_000, est, 12_000);
    expect(fresh.timeS).toBe(Math.round(predictTimeS(45, 10_000)));
    expect(fresh.fastS).toBeLessThan(fresh.timeS);
    expect(fresh.slowS).toBeGreaterThan(fresh.timeS);
    const short = predictRace(21_097.5, est, 6000);
    expect(short.endurancePct).toBeGreaterThan(0);
    expect(short.confidence).not.toBe("medium");
  });

  it("vdotFor inverts the prediction", () => {
    const t = predictTimeS(48, 10_000);
    expect(vdotFor(10_000, t, 12_000)).toBeCloseTo(48, 1);
  });

  it("classifies the gap honestly", () => {
    const pred = Math.round(predictTimeS(45, 10_000));
    const base = { today: "2026-11-02", estimate: est, longestRecentM: 12_000 };
    expect(raceStatus({ ...base, goal: { ...goal, targetTimeS: pred + 60 } }).verdict).toBe("ahead");
    expect(raceStatus({ ...base, goal: { ...goal, targetTimeS: pred - 20 } }).verdict).toBe("in_range");
    const far = raceStatus({ ...base, goal: { ...goal, targetTimeS: pred - 300 } });
    expect(far.verdict).toBe("stretch");
    expect(far.gapS).toBe(300);
    expect(far.vdotForTarget!).toBeGreaterThan(45);
    expect(raceStatus({ ...base, goal: { ...goal, targetTimeS: pred - 300 }, projection: { projectedS: pred - 320, fastS: pred - 400, slowS: pred - 100 } }).verdict).toBe("projected");
    expect(raceStatus({ ...base, goal }).verdict).toBe("no_target");
    expect(raceStatus({ ...base, estimate: null, goal }).verdict).toBe("no_estimate");
  });

  it("counts down and notices a past race", () => {
    const s = raceStatus({ goal, today: "2027-04-10", estimate: est, longestRecentM: 12_000 });
    expect(s.daysToGo).toBe(14);
    expect(s.weeksToGo).toBe(2);
    expect(raceStatus({ goal, today: "2027-04-25", estimate: est, longestRecentM: 12_000 }).past).toBe(true);
  });

  it("reads race goals from goal rows", () => {
    expect(raceGoalFromRow({ id: "g", kind: "half", name: null, distance_m: null, race_date: "2027-03-14", target_time_s: 6600 })).toMatchObject({ name: "Half marathon", distanceM: 21_097.5 });
    expect(raceGoalFromRow({ id: "g", kind: "5k", name: null, distance_m: null, race_date: null, target_time_s: null })).toMatchObject({ name: "5 km", raceDate: null });
    expect(raceGoalFromRow({ id: "g", kind: "race", name: "Holmenkollen", distance_m: 12_000, race_date: "2027-05-01" })!.name).toBe("Holmenkollen");
    expect(raceGoalFromRow({ id: "g", kind: "consistency" })).toBeNull();
  });
});

describe("plan projection on the race page", () => {
  it("re-projects the stored plan projection from current fitness, or returns null without one", async () => {
    const { livePlanProjection } = await import("@/lib/race/projection");
    const { project } = await import("@/lib/planning/projection");
    const start = project({ vdot: 42, distanceM: 10_000, label: "10 km", trainingWeeks: 20, volumeFactor: 1, longestPlannedM: 14_000, currentLongestM: 10_000, asOf: "2026-10-01" });
    const weeks = Array.from({ length: 20 }, (_, i) => ({ index: i, start: new Date(Date.UTC(2026, 9, 5 + i * 7)).toISOString().slice(0, 10), phase: "build", targetMinutes: 100, note: "" }));
    const plan = { config: { projection: start }, weeks };
    const live = livePlanProjection(plan, { estimate: { withheld: false, vdot: 44 }, longestRecentM: 12_000 }, [], "2026-11-02")!;
    expect(live.projectedS).toBeLessThan(start.projectedS);
    expect(livePlanProjection(plan, null, [], "2026-11-02")!.projectedS).toBe(start.projectedS);
    expect(livePlanProjection({ config: {} }, null, [], "2026-11-02")).toBeNull();
  });
});
