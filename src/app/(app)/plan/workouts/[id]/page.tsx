import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { Steps } from "@/components/plan/steps";
import { WorkoutActions } from "./workout-actions";
import { createUserClient } from "@/lib/db/server";
import { formatDay, todayIn } from "@/lib/dates";
import { WORKOUT_LABEL, type WorkoutType } from "@/lib/planning/types";
import { formatDuration, formatPace } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "muted" | "accent" | "hr" | "warn" }> = {
  planned: { label: "Planned", tone: "muted" },
  completed: { label: "Done", tone: "accent" },
  missed: { label: "Missed", tone: "hr" },
  skipped: { label: "Skipped", tone: "muted" },
};

export default async function WorkoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createUserClient();
  const { data: w } = await db.from("planned_workouts").select("*").eq("id", id).maybeSingle();
  if (!w) notFound();
  const today = todayIn(await userTimezone());
  const ex = w.execution;
  const st = STATUS[w.status] ?? STATUS.planned;
  return (
    <>
      <PageHeader title={w.title} subtitle={`${formatDay(w.date, { weekday: "long", day: "numeric", month: "long" })} · ${WORKOUT_LABEL[w.type as WorkoutType]}`} />
      <div className="space-y-4">
        <Link href="/plan" className="text-sm text-accent">
          ← Back to plan
        </Link>
        <Card>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            {w.key && <Badge tone="accent">Key session</Badge>}
            {w.locked && <Badge>Locked</Badge>}
            {w.source !== "generator" && <Badge tone="warn">{w.source === "athlete" ? "Changed by you" : "Adapted"}</Badge>}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-5">
            <Stat label="Time" value={formatDuration(w.duration_s)} size="md" />
            <Stat label="Distance" value={w.distance_m ? `≈ ${(w.distance_m / 1000).toFixed(1)}` : "–"} unit={w.distance_m ? "km" : undefined} size="md" hint={w.distance_m ? "estimated from target paces" : undefined} />
          </div>
          <p className="mt-4 text-sm font-semibold">{w.objective}</p>
          <p className="mt-1 text-sm text-muted">{w.why}</p>
        </Card>

        {ex && (
          <Card>
            <div className="label">How it went</div>
            <div className="mt-3 grid grid-cols-3 gap-4">
              <Stat label="Of planned time" value={ex.durationRatio != null ? `${Math.round(ex.durationRatio * 100)} %` : "–"} size="md" />
              <Stat label="Work pace" value={ex.workPace ? formatPace(ex.workPace) : "–"} size="md" hint={ex.targetPace ? `target ${formatPace(ex.targetPace[0])}–${formatPace(ex.targetPace[1])}` : undefined} />
              <Stat label="Avg HR" value={ex.avgHr ? Math.round(ex.avgHr) : "–"} size="md" />
            </div>
            {ex.notes?.length > 0 && (
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted">
                {ex.notes.map((n: string, i: number) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted">Work pace is your fastest stretch matching one work bout, from the recorded data.</p>
            {w.activity_id && (
              <Link href={`/activities/${w.activity_id}`} className="mt-3 inline-block text-sm text-accent">
                Open the run →
              </Link>
            )}
          </Card>
        )}

        <Card>
          <div className="label mb-3">Session</div>
          <Steps steps={w.steps} />
        </Card>

        {w.status !== "completed" && <WorkoutActions id={w.id} date={w.date} today={today} locked={w.locked} status={w.status} type={w.type} />}
      </div>
    </>
  );
}
