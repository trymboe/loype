import { describe, expect, it } from "vitest";
import { canOpen, needsSetup, nextStep, readBackground, type OnboardingFacts } from "@/lib/onboarding/state";
import { summarizeBaseline, type SummaryInput } from "@/lib/onboarding/summary";
import type { Baseline } from "@/lib/planning/types";

const facts = (o: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  garminConnected: false,
  historyImported: false,
  importRunning: false,
  hasPlan: false,
  prefs: {},
  ...o,
});

describe("onboarding steps", () => {
  it("walks connect → import → baseline → about → goal → done", () => {
    expect(nextStep(facts())).toBe("connect");
    expect(nextStep(facts({ garminConnected: true }))).toBe("import");
    expect(nextStep(facts({ garminConnected: true, historyImported: true, importRunning: true }))).toBe("import");
    expect(nextStep(facts({ garminConnected: true, historyImported: true }))).toBe("baseline");
    expect(nextStep(facts({ garminConnected: true, historyImported: true, prefs: { baselineSeenAt: "x" } }))).toBe("about");
    expect(nextStep(facts({ garminConnected: true, historyImported: true, prefs: { baselineSeenAt: "x", aboutDoneAt: "x" } }))).toBe("goal");
    expect(nextStep(facts({ garminConnected: true, historyImported: true, hasPlan: true, prefs: { baselineSeenAt: "x", aboutDoneAt: "x" } }))).toBe("done");
  });

  it("doesn't ask to connect when runs already exist (e.g. Garmin key since removed)", () => {
    expect(nextStep(facts({ historyImported: true }))).toBe("baseline");
  });

  it("only opens steps up to the current one, any once done", () => {
    const f = facts({ garminConnected: true });
    expect(canOpen("connect", f)).toBe(true);
    expect(canOpen("import", f)).toBe(true);
    expect(canOpen("goal", f)).toBe(false);
    expect(canOpen("goal", facts({ garminConnected: true, historyImported: true, hasPlan: true, prefs: { baselineSeenAt: "x", aboutDoneAt: "x" } }))).toBe(true);
  });

  it("stops prompting once skipped or finished", () => {
    expect(needsSetup(facts())).toBe(true);
    expect(needsSetup(facts({ prefs: { dismissedAt: "x" } }))).toBe(false);
  });

  it("reads the training background defensively", () => {
    expect(readBackground(null)).toEqual({ experience: null, injuryConcern: false, injuryNote: null, intervals: true, longRuns: true });
    expect(readBackground({ athlete: { experience: "regular", injuryConcern: true, injuryNote: "  shin  ", intervals: false, longRuns: true } })).toEqual({
      experience: "regular",
      injuryConcern: true,
      injuryNote: "shin",
      intervals: false,
      longRuns: true,
    });
    expect(readBackground({ athlete: { experience: "elite" } }).experience).toBeNull();
  });
});

const baseline = (o: Partial<Baseline> = {}): Baseline => ({
  asOf: "2026-11-02",
  vdot: 41.5,
  vdotRange: [40, 43],
  vdotConfidence: "medium",
  paceZones: [{ key: "threshold", label: "Threshold", fastSPerKm: 288, slowSPerKm: 295, purpose: "" }] as Baseline["paceZones"],
  hrZones: null,
  thresholdHr: null,
  weeklyMinutes: 50,
  weeklyKm: 9,
  runsPerWeek: 1.5,
  consistency: 0.625,
  longestRunMinutes: 55,
  predictions: [],
  ...o,
});

const input = (o: Partial<SummaryInput> = {}): SummaryInput => ({
  baseline: baseline(),
  efficiencyChangePer30dPct: null,
  historyDays: 365,
  runCount: 40,
  maxHrSource: "observed",
  ...o,
});

const titles = (ps: { title: string }[]) => ps.map((p) => p.title);

describe("baseline summary", () => {
  it("names a solid fitness signal as a strength and low frequency as worth developing", () => {
    const s = summarizeBaseline(input());
    expect(titles(s.strengths)).toEqual(["Clear fitness signal"]);
    expect(s.strengths[0].detail).toContain("VDOT 41.5");
    expect(s.strengths[0].detail).toContain("4:48–4:55/km");
    expect(titles(s.develop)).toEqual(["Frequency"]);
    expect(s.caveats).toEqual([]);
  });

  it("recognises consistency, frequency, endurance and improving efficiency", () => {
    const s = summarizeBaseline(input({ baseline: baseline({ consistency: 1, runsPerWeek: 4, longestRunMinutes: 95 }), efficiencyChangePer30dPct: 2.3 }));
    expect(titles(s.strengths)).toEqual(["Consistent", "Run often", "Endurance base", "Clear fitness signal", "Getting more efficient"]);
    expect(s.develop).toEqual([]);
  });

  it("is honest about thin data instead of inventing strengths", () => {
    const s = summarizeBaseline(
      input({ baseline: baseline({ vdot: null, vdotRange: null, vdotConfidence: null, consistency: 0.25, longestRunMinutes: 30 }), historyDays: 30, maxHrSource: "age_formula" }),
    );
    expect(s.strengths).toEqual([]);
    expect(titles(s.develop)).toEqual(["Consistency", "Frequency", "Long run", "Fitness benchmark"]);
    expect(titles(s.caveats)).toEqual(["Short history", "Max heart rate is estimated"]);
    expect(s.caveats[0].detail).toContain("4 weeks");
  });

  it("treats a low-confidence estimate as a caveat, not a strength", () => {
    const s = summarizeBaseline(input({ baseline: baseline({ vdotConfidence: "low" }) }));
    expect(titles(s.strengths)).not.toContain("Clear fitness signal");
    expect(titles(s.caveats)).toContain("Rough fitness estimate");
  });

  it("says there is nothing to go on with no runs", () => {
    const s = summarizeBaseline(input({ runCount: 0 }));
    expect(s.strengths).toEqual([]);
    expect(titles(s.caveats)).toEqual(["No runs yet"]);
  });
});

describe("welcome guide on first login", () => {
  it("shows for a brand-new account only", async () => {
    const { showWelcomeGuide } = await import("@/lib/onboarding/state");
    expect(showWelcomeGuide({ connected: false, hasRuns: false, prefs: {} })).toBe(true);
    expect(showWelcomeGuide({ connected: true, hasRuns: false, prefs: {} })).toBe(false);
    expect(showWelcomeGuide({ connected: false, hasRuns: true, prefs: {} })).toBe(false);
    expect(showWelcomeGuide({ connected: false, hasRuns: false, prefs: { guideSeenAt: "2026-11-05T00:00:00Z" } })).toBe(false);
    expect(showWelcomeGuide({ connected: false, hasRuns: false, prefs: { dismissedAt: "2026-11-05T00:00:00Z" } })).toBe(false);
  });
});
