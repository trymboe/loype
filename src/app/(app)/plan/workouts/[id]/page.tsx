import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Badge, Card, CardHeader, PageHeader, Stat, type Tone } from "@/components/ui";
import { Steps } from "@/components/plan/steps";
import { WorkoutActions } from "./workout-actions";
import { StepEditor } from "./step-editor";
import { toEditable } from "@/lib/planning/edit-steps";
import { analyzeIntervals, mainRepeat } from "@/lib/planning/intervals";
import { IntervalReps } from "@/components/plan/interval-reps";
import { createUserClient } from "@/lib/db/server";
import { formatDay, todayIn } from "@/lib/dates";
import { WORKOUT_LABEL, type WorkoutType } from "@/lib/planning/types";
import { formatDuration, formatPace } from "@/lib/units";
import { userTimezone } from "@/lib/user-tz";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "muted" },
  completed: { label: "Done", tone: "good" },
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
  // per-rep analysis of interval sessions, from the recorded stream and laps
  let reps = null;
  if (w.activity_id && mainRepeat(w.steps ?? [])) {
    const [{ data: stream }, { data: laps }] = await Promise.all([
      db.from("activity_streams").select("t, speed, hr, distance").eq("activity_id", w.activity_id).maybeSingle(),
      db.from("activity_laps").select("start_offset_s, timer_s, elapsed_s, distance_m, avg_speed, avg_hr, max_hr").eq("activity_id", w.activity_id).order("lap_index"),
    ]);
    reps = analyzeIntervals(w.steps, stream, laps ?? []);
  }
  const st = STATUS[w.status] ?? STATUS.planned;
  return (
    <>
      <PageHeader back={{ href: "/plan", label: "Plan" }} title={w.title} eyebrow={`${formatDay(w.date, { weekday: "long", day: "numeric", month: "long" })} · ${WORKOUT_LABEL[w.type as WorkoutType]}`} />
      <div className="stagger space-y-3">
        <Card>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            {w.key && <Badge tone="accent">Key session</Badge>}
            {w.locked && <Badge>Locked</Badge>}
            {w.source !== "generator" && <Badge tone="warn">{w.source === "athlete" ? "Changed by you" : "Adapted"}</Badge>}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-5">
            <Stat label="Time" value={formatDuration(w.duration_s)} />
            <Stat label="Distance" value={w.distance_m ? `≈ ${(w.distance_m / 1000).toFixed(1)}` : "–"} unit={w.distance_m ? "km" : undefined} hint={w.distance_m ? "estimated from target paces" : undefined} />
          </div>
          <div className="mt-5 border-t border-[var(--hairline)] pt-4">
            <p className="text-[0.9375rem] font-semibold">{w.objective}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{w.why}</p>
          </div>
        </Card>

        {ex && (
          <Card>
            <CardHeader title="How it went" />
            <div className="mt-4 grid grid-cols-3 gap-4">
              <Stat label="Of planned time" value={ex.durationRatio != null ? `${Math.round(ex.durationRatio * 100)} %` : "–"} size="md" />
              <Stat label="Work pace" value={ex.workPace ? formatPace(ex.workPace) : "–"} size="md" hint={ex.targetPace ? `target ${formatPace(ex.targetPace[0])}–${formatPace(ex.targetPace[1])}` : undefined} />
              <Stat label="Avg HR" value={ex.avgHr ? Math.round(ex.avgHr) : "–"} size="md" />
            </div>
            {ex.notes?.length > 0 && (
              <ul className="mt-4 space-y-1 rounded-xl bg-surface-2 p-3 text-sm leading-snug text-fg-2">
                {ex.notes.map((n: string, i: number) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            {reps ? <IntervalReps a={reps} /> : <p className="mt-3 text-xs text-muted">Work pace is your fastest stretch matching one work bout, from the recorded data.</p>}
            {w.activity_id && (
              <Link href={`/activities/${w.activity_id}`} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                Open the run <ArrowRight size={15} />
              </Link>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="Session" className="mb-4" />
          <Steps steps={w.steps} />
          {w.status === "planned" && w.type !== "rest" && w.type !== "race" && w.steps?.length > 0 && (
            <div className="mt-4 border-t border-[var(--hairline)] pt-4">
              <StepEditor id={w.id} initial={toEditable(w.steps)} />
            </div>
          )}
        </Card>

        {w.status !== "completed" && <WorkoutActions id={w.id} date={w.date} today={today} locked={w.locked} status={w.status} type={w.type} />}
      </div>
    </>
  );
}
