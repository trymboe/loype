import { Card, CardHeader, Stat } from "@/components/ui";
import { addDaysIso } from "@/lib/dates";
import { createAdminClient } from "@/lib/db/server";
import type { Baseline } from "@/lib/planning/types";
import { suggestedRunsPerWeek } from "@/lib/planning/generator";
import { formatPace } from "@/lib/units";

/** Form defaults: every day available, long-run day from where your longest runs fall, runs per week from your history. */
export async function defaultsFor(userId: string, today: string, b: Baseline) {
  const db = createAdminClient();
  const { data } = await db
    .from("activities")
    .select("local_date, moving_s")
    .eq("user_id", userId)
    .eq("sport", "running")
    .is("duplicate_of", null)
    .gte("local_date", addDaysIso(today, -56));
  const longest = new Array(7).fill(0);
  for (const a of data ?? []) {
    const dow = (new Date(`${a.local_date}T00:00:00Z`).getUTCDay() + 6) % 7;
    longest[dow] = Math.max(longest[dow], a.moving_s ?? 0);
  }
  const longRunDay = longest.some((x) => x > 0) ? longest.indexOf(Math.max(...longest)) : 6;
  return { runDays: [0, 1, 2, 3, 4, 5, 6], longRunDay, today, suggestedRuns: suggestedRunsPerWeek(b), recentRuns: b.runsPerWeek };
}

export function BaselineCard({ b }: { b: Baseline }) {
  const t = b.paceZones?.find((z) => z.key === "threshold");
  return (
    <Card>
      <CardHeader title="Starting point" aside="Last 4–8 weeks" />
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-4">
        <Stat label="Weekly time" value={b.weeklyMinutes} unit="min" size="md" hint="avg last 4 weeks" />
        <Stat label="Runs / week" value={b.runsPerWeek.toFixed(1)} size="md" hint={`${Math.round(b.consistency * 8)} of 8 weeks with runs`} />
        <Stat label="Longest run" value={b.longestRunMinutes} unit="min" size="md" hint="last 8 weeks" />
        <Stat label="Fitness" value={b.vdot ? b.vdot.toFixed(1) : "–"} size="md" hint={b.vdot ? `VDOT, ${b.vdotConfidence} confidence` : "no estimate yet"} />
      </div>
      {t && (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Sessions will use your zones, e.g. threshold {formatPace(t.fastSPerKm)}–{formatPace(t.slowSPerKm)}/km. They update as your fitness changes.
        </p>
      )}
    </Card>
  );
}
