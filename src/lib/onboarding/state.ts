/**
 * Guided first-run setup: connect Garmin → import history → baseline summary
 * → about you → goal and plan. Pure; the page gathers the facts.
 */

export const STEPS = ["connect", "import", "baseline", "about", "goal"] as const;
export type StepKey = (typeof STEPS)[number];

export const STEP_LABEL: Record<StepKey, string> = {
  connect: "Connect Garmin",
  import: "Import history",
  baseline: "Your baseline",
  about: "About you",
  goal: "Goal and plan",
};

/** Short names for the step indicator. */
export const STEP_SHORT: Record<StepKey, string> = { connect: "Garmin", import: "History", baseline: "Baseline", about: "About you", goal: "Goal" };

export type Experience = "new" | "returning" | "regular" | "experienced";

export const EXPERIENCE_LABEL: Record<Experience, { label: string; hint: string }> = {
  new: { label: "New to running", hint: "Less than a year, or never trained to a plan" },
  returning: { label: "Coming back", hint: "Ran before, getting going again" },
  regular: { label: "Regular runner", hint: "A year or more of steady running" },
  experienced: { label: "Experienced", hint: "Several years, structured training, races" },
};

/** Training background the athlete tells us (athlete_profile.preferences.athlete). */
export interface AthleteBackground {
  experience: Experience | null;
  /** an injury or recurring niggle the plan should respect */
  injuryConcern: boolean;
  injuryNote: string | null;
  intervals: boolean;
  longRuns: boolean;
}

/** athlete_profile.preferences.onboarding */
export interface OnboardingPrefs {
  baselineSeenAt?: string;
  aboutDoneAt?: string;
  /** set when the athlete skips the rest of setup */
  dismissedAt?: string;
}

export interface OnboardingFacts {
  garminConnected: boolean;
  /** a historical import has completed (or runs exist from any source) */
  historyImported: boolean;
  importRunning: boolean;
  hasPlan: boolean;
  prefs: OnboardingPrefs;
}

/** The first step that still needs doing, or "done". */
export function nextStep(f: OnboardingFacts): StepKey | "done" {
  if (!f.garminConnected && !f.historyImported) return "connect";
  if (!f.historyImported || f.importRunning) return "import";
  if (!f.prefs.baselineSeenAt) return "baseline";
  if (!f.prefs.aboutDoneAt) return "about";
  if (!f.hasPlan) return "goal";
  return "done";
}

/** Steps up to and including the current one can be opened; later ones can't. */
export function canOpen(step: StepKey, f: OnboardingFacts): boolean {
  const n = nextStep(f);
  if (n === "done") return true;
  return STEPS.indexOf(step) <= STEPS.indexOf(n);
}

/** Whether to show the "finish setting up" prompt on Today. */
export function needsSetup(f: OnboardingFacts): boolean {
  return !f.prefs.dismissedAt && nextStep(f) !== "done";
}

export function readBackground(prefs: unknown): AthleteBackground {
  const a = ((prefs as { athlete?: Record<string, unknown> } | null)?.athlete ?? {}) as Record<string, unknown>;
  const exp = a.experience;
  return {
    experience: typeof exp === "string" && exp in EXPERIENCE_LABEL ? (exp as Experience) : null,
    injuryConcern: a.injuryConcern === true,
    injuryNote: typeof a.injuryNote === "string" && a.injuryNote.trim() ? a.injuryNote.trim().slice(0, 500) : null,
    intervals: a.intervals !== false,
    longRuns: a.longRuns !== false,
  };
}

export function readOnboarding(prefs: unknown): OnboardingPrefs {
  const o = (prefs as { onboarding?: OnboardingPrefs } | null)?.onboarding;
  return o && typeof o === "object" ? o : {};
}
