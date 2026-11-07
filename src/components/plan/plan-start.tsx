import { Card, CardHeader, Stat } from "@/components/ui";
import { createAdminClient } from "@/lib/db/server";
import { loadPreferences } from "@/lib/onboarding/facts";
import { readBackground } from "@/lib/onboarding/state";
import type { Baseline } from "@/lib/planning/types";

/** Form defaults: every day available, the long-run day left to the planner ("best fit"), runs per week from your history, plus what you told Løype at setup. */
export async function defaultsFor(userId: string, today: string, b: Baseline) {
  const prefs = await loadPreferences(createAdminClient(), userId);
  return {
    runDays: [0, 1, 2, 3, 4, 5, 6],
    longRunDay: null as number | null,
    today,
    recentRuns: b.runsPerWeek,
    runMinutes: b.habitualRunMinutes ?? null,
    background: readBackground(prefs),
  };
}

export function BaselineCard({ b }: { b: Baseline }) {
  return (
    <Card>
      <CardHeader title="Starting point" aside="Last 4–8 weeks" />
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-4">
        <Stat label="Avg week" value={b.weeklyMinutes} unit="min" size="md" />
        <Stat label="Runs / week" value={b.runsPerWeek.toFixed(1)} size="md" hint={`${Math.round(b.consistency * 8)} of 8 weeks with runs`} />
        <Stat label="Longest run" value={b.longestRunMinutes} unit="min" size="md" />
        <Stat label="VDOT" value={b.vdot ? b.vdot.toFixed(1) : "–"} size="md" hint={b.vdot ? `${b.vdotConfidence} confidence` : undefined} />
      </div>
    </Card>
  );
}
