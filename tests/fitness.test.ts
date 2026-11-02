import { describe, expect, it } from "vitest";
import { parseFitActivity } from "@/lib/fit/parse";
import { deriveActivity } from "@/lib/analytics/summarize";
import { extractFeatures } from "@/lib/analytics/fitness/features";
import { derivePhysiology, hrZones, type Physiology } from "@/lib/analytics/fitness/physiology";
import { scoreRun, trimpFromAverage, type RunRecord } from "@/lib/analytics/fitness/scoring";
import { endurancePenalty, estimateFitness } from "@/lib/analytics/fitness/estimate";
import { loadSeries } from "@/lib/analytics/fitness/load";
import { runModel, retrospectiveDates, snapshotsFrom } from "@/lib/analytics/fitness/model";
import { predictTimeS, trainingPaces, vdotFromPerformance } from "@/lib/analytics/fitness/vdot";
import { addDaysIso } from "@/lib/dates";
import { buildFit, type SyntheticOptions } from "./fit-builder";

let seq = 0;
function makeRun(opts: SyntheticOptions, date: string, extra: Partial<RunRecord> = {}): RunRecord {
  const a = parseFitActivity(buildFit({ ...opts, start: new Date(`${date}T06:00:00Z`) }));
  const d = deriveActivity(a);
  const features = extractFeatures({
    t: a.streams.t,
    distance: d.motion.distance,
    hr: a.streams.hr,
    altitude: a.streams.altitude,
    motion_states: d.motion.intervals.map((iv) => iv.state[0]).join(""),
  });
  return {
    id: `run-${++seq}`,
    date,
    name: "Morning run",
    distanceM: d.summary.distanceM,
    movingS: d.summary.movingS,
    avgHr: d.summary.avgHr,
    paceReliable: d.quality.paceReliable,
    hrReliable: d.quality.hrReliable,
    usableForFitness: d.quality.usableForFitness,
    isIndoor: false,
    features,
    classificationOverride: null,
    ...extra,
  };
}

const phys = (max = 190, rest = 50): Physiology => ({
  maxHr: { value: max, source: "manual", note: "" },
  restHr: { value: rest, source: "manual", note: "" },
  trimpK: { a: 0.64, b: 1.92, note: "" },
});

describe("Daniels VDOT model", () => {
  it("matches Daniels' published table", () => {
    expect(vdotFromPerformance(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    expect(predictTimeS(50, 10_000)).toBeCloseTo(41 * 60 + 21, -1);
    expect(predictTimeS(50, 42_195) / 60).toBeCloseTo(190.8, 0);
    const t = trainingPaces(50).find((z) => z.key === "threshold")!;
    // Daniels T pace for VDOT 50 ≈ 4:15/km
    expect((t.fastSPerKm + t.slowSPerKm) / 2).toBeGreaterThan(245);
    expect((t.fastSPerKm + t.slowSPerKm) / 2).toBeLessThan(262);
  });
});

describe("run features", () => {
  it("finds best efforts and excludes paused time", () => {
    const r = makeRun({ segments: [{ durationS: 1500, speedMs: 4, hr: 160 }, { durationS: 120, speedMs: 0, hr: 120, paused: true }, { durationS: 600, speedMs: 3, hr: 150 }] }, "2026-10-01");
    const f = r.features!;
    const k5 = f.bestEfforts.find((e) => e.distanceM === 5000)!;
    expect(k5.timeS).toBeGreaterThan(1245);
    expect(k5.timeS).toBeLessThan(1256);
    expect(f.timerS).toBeCloseTo(2100, -1);
    expect(f.hrHist.reduce((a, b) => a + b, 0)).toBeCloseTo(2100, -1);
    expect(f.maxSustainedHr).toBe(160);
  });

  it("works with Garmin smart recording (a sample every few seconds)", () => {
    const r = makeRun({ segments: [{ durationS: 1800, speedMs: 3.2, hr: 150 }, { durationS: 120, speedMs: 4.5, hr: 178 }], recordIntervalS: 4 }, "2026-10-01");
    const f = r.features!;
    expect(f.maxSustainedHr).toBe(178);
    expect(f.steady!.avgHr).toBeGreaterThan(149);
    expect(f.bestEfforts.find((e) => e.distanceM === 5000)).toBeTruthy();
    expect(f.hrHist.reduce((a, b) => a + b, 0)).toBeCloseTo(1920, -1);
  });

  it("detects intervals", () => {
    const segs = [{ durationS: 600, speedMs: 3, hr: 140 }];
    for (let i = 0; i < 6; i++) segs.push({ durationS: 90, speedMs: 5, hr: 175 }, { durationS: 120, speedMs: 2.8, hr: 150 });
    const r = makeRun({ segments: segs }, "2026-10-01");
    expect(r.features!.fastBouts).toBeGreaterThanOrEqual(5);
    const s = scoreRun(r, phys(), { vdot: null, medianRecentMovingS: null });
    expect(s.classification).toBe("intervals");
  });
});

describe("physiology", () => {
  it("uses the second-highest sustained HR so one artefact can't set max HR, and the overnight proxy for resting HR", () => {
    const runs = [195, 186, 184, 170].map((h, i) => ({ activityId: String(i), date: "2026-10-0" + (i + 1), maxSustainedHr: h, hrReliable: true }));
    const wellness = Array.from({ length: 10 }, (_, i) => ({ date: addDaysIso("2026-10-20", i), metric: "sleep_avg_hr", value: 52 + (i % 3) }));
    const p = derivePhysiology("2026-10-30", null, runs, wellness);
    expect(p.maxHr).toMatchObject({ value: 186, source: "observed" });
    expect(p.restHr).toMatchObject({ value: 53, source: "overnight_proxy" });
    expect(hrZones(p)![1]).toMatchObject({ zone: 2, minBpm: 53 + Math.round(0.6 * 133) });
  });

  it("prefers values the athlete entered", () => {
    const p = derivePhysiology("2026-10-30", { max_hr: 200, max_hr_source: "manual", resting_hr: 45, resting_hr_source: "manual", birth_year: null, sex: "female" }, [], []);
    expect(p.maxHr!.value).toBe(200);
    expect(p.restHr!.value).toBe(45);
    expect(p.trimpK.a).toBe(0.86);
  });
});

// 5:00/km at HR 148 with rest 50 / max 190 implies VO2max ≈ 50 by the Swain relation
const steady = (hr = 148, speed = 1000 / 300, durationS = 2400) => ({ segments: [{ durationS, speedMs: speed, hr }] });

describe("fitness estimate", () => {
  it("withholds the estimate when evidence is thin", () => {
    const runs = [makeRun(steady(), "2026-10-20"), makeRun(steady(), "2026-10-25")];
    const scored = runs.map((run) => ({ run, score: scoreRun(run, phys(), { vdot: null, medianRecentMovingS: null }) }));
    const e = estimateFitness("2026-10-30", scored, phys());
    expect(e.withheld).toBe(true);
  });

  it("estimates from the HR–speed relationship with a range, and isn't swung by one outlier", () => {
    const runs = [0, 4, 8, 12, 16, 20].map((d) => makeRun(steady(), addDaysIso("2026-10-01", d)));
    const out = runModel({ asOf: "2026-10-30", profile: { max_hr: 190, max_hr_source: "manual", resting_hr: 50, resting_hr_source: "manual", birth_year: null, sex: null }, runs, others: [], wellness: [] });
    expect(out.estimate.withheld).toBe(false);
    if (out.estimate.withheld) return;
    expect(out.estimate.method).toBe("hr_speed");
    expect(out.estimate.vdot).toBeGreaterThan(48);
    expect(out.estimate.vdot).toBeLessThan(52);
    expect(out.estimate.lower).toBeLessThan(out.estimate.vdot);
    expect(out.estimate.upper).toBeGreaterThan(out.estimate.vdot);

    // one implausibly good session (same pace, much lower HR)
    const withOutlier = [...runs, makeRun(steady(120), "2026-10-28")];
    const out2 = runModel({ asOf: "2026-10-30", profile: { max_hr: 190, max_hr_source: "manual", resting_hr: 50, resting_hr_source: "manual", birth_year: null, sex: null }, runs: withOutlier, others: [], wellness: [] });
    if (out2.estimate.withheld) throw new Error("withheld");
    expect(Math.abs(out2.estimate.vdot - out.estimate.vdot)).toBeLessThan(1.5);
  });

  it("uses a near-maximal effort as performance evidence", () => {
    const runs = [0, 4, 8].map((d) => makeRun(steady(), addDaysIso("2026-10-01", d)));
    // 5 km in 20:00 at 93 % HRR
    runs.push(makeRun({ segments: [{ durationS: 300, speedMs: 3, hr: 140 }, { durationS: 1200, speedMs: 5000 / 1200, hr: 181 }] }, "2026-10-20"));
    const scored = runs.map((run) => ({ run, score: scoreRun(run, phys(), { vdot: null, medianRecentMovingS: null }) }));
    const e = estimateFitness("2026-10-30", scored, phys());
    if (e.withheld) throw new Error("withheld");
    expect(e.method).toBe("performance");
    expect(e.vdot).toBeCloseTo(vdotFromPerformance(5000, 1200), 0);
  });

  it("slows long-race predictions when long runs are missing", () => {
    expect(endurancePenalty(10_000, 8000)).toBe(0);
    expect(endurancePenalty(42_195, 8000)).toBeGreaterThan(0.08);
    expect(endurancePenalty(42_195, 32_000)).toBe(0);
  });
});

describe("load", () => {
  it("builds CTL/ATL that converge on constant load", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ date: addDaysIso("2026-01-01", i), trimp: 100, kind: "run" as const }));
    const s = loadSeries(items, "2026-01-01", addDaysIso("2026-01-01", 199));
    const last = s[s.length - 1];
    expect(last.ctl).toBeGreaterThan(98);
    expect(last.atl).toBeGreaterThan(99);
    expect(Math.abs(last.tsb)).toBeLessThan(2);
  });

  it("estimates load from pace when HR is unreliable (cadence lock)", () => {
    const r = makeRun({ segments: [{ durationS: 2400, speedMs: 3.3, hr: 0 }], hrFollowsCadence: true }, "2026-10-01");
    expect(r.hrReliable).toBe(false);
    const s = scoreRun(r, phys(), { vdot: 50, medianRecentMovingS: null });
    expect(s.trimpMethod).toBe("pace_estimate");
    expect(s.trimp).toBeGreaterThan(20);
    expect(s.vo2maxFromHr).toBeNull();
  });

  it("scores cross-training from duration and average HR", () => {
    expect(trimpFromAverage(3600, 120, phys())).toBeGreaterThan(30);
  });
});

describe("snapshots", () => {
  it("emits weekly retrospective dates and flat snapshot rows", () => {
    expect(retrospectiveDates("2026-10-01", "2026-10-30")).toEqual(["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]);
    const runs = [0, 4, 8, 12].map((d) => makeRun(steady(), addDaysIso("2026-10-01", d)));
    const out = runModel({ asOf: "2026-10-30", profile: { max_hr: 190, max_hr_source: "manual", resting_hr: 50, resting_hr_source: "manual", birth_year: null, sex: null }, runs, others: [], wellness: [] });
    const rows = snapshotsFrom(out);
    expect(rows.find((r) => r.metric === "vdot")!.value).toBeGreaterThan(45);
    expect(rows.find((r) => r.metric === "race_5k")).toBeTruthy();
  });
});
