import { Card, Stat } from "@/components/ui";
import { addDaysIso } from "@/lib/dates";
import { createAdminClient } from "@/lib/db/server";
import type { Baseline } from "@/lib/planning/types";
import { formatPace } from "@/lib/units";

/** Suggested run days and long-run day from the weekdays you have actually been running. */
export async function defaultsFor(userId: string, today: string) {
  const db = createAdminClient();
  const { data } = await db
    .from("activities")
    .select("local_date, moving_s")
    .eq("user_id", userId)
    .eq("sport", "running")
    .is("duplicate_of", null)
    .gte("local_date", addDaysIso(today, -56));
  const count = new Array(7).fill(0);
  const longest = new Array(7).fill(0);
  for (const a of data ?? []) {
    const dow = (new Date(`${a.local_date}T00:00:00Z`).getUTCDay() + 6) % 7;
    count[dow]++;
    longest[dow] = Math.max(longest[dow], a.moving_s ?? 0);
  }
  const perWeek = Math.round((data?.length ?? 0) / 8);
  const n = Math.max(3, Math.min(6, perWeek || 3));
  const ranked = count.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c || a.i - b.i);
  const runDays = (ranked[0].c ? ranked.slice(0, n).map((x) => x.i) : [1, 3, 5, 6]).sort();
  const longRunDay = longest.some((x) => x > 0) ? longest.indexOf(Math.max(...longest)) : 6;
  return { runDays: runDays.includes(longRunDay) ? runDays : [...runDays.slice(0, n - 1), longRunDay].sort(), longRunDay, today };
}

export function BaselineCard({ b }: { b: Baseline }) {
  const t = b.paceZones?.find((z) => z.key === "threshold");
  return (
    <Card>
      <div className="label">Starting point</div>
      <div className="mt-3 grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Weekly time" value={b.weeklyMinutes} unit="min" size="md" hint="avg last 4 weeks" />
        <Stat label="Runs / week" value={b.runsPerWeek.toFixed(1)} size="md" hint={`${Math.round(b.consistency * 8)} of 8 weeks with runs`} />
        <Stat label="Longest run" value={b.longestRunMinutes} unit="min" size="md" hint="last 8 weeks" />
        <Stat label="Fitness" value={b.vdot ? b.vdot.toFixed(1) : "–"} size="md" hint={b.vdot ? `VDOT, ${b.vdotConfidence} confidence` : "no estimate yet"} />
      </div>
      {t && (
        <p className="mt-3 text-xs text-muted">
          Sessions will use your zones, e.g. threshold {formatPace(t.fastSPerKm)}–{formatPace(t.slowSPerKm)}/km. They update as your fitness changes.
        </p>
      )}
    </Card>
  );
}
