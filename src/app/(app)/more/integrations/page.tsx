/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { Send, Watch } from "lucide-react";
import { Badge, IconTile, PageHeader, type Tone } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { getIntegrationStatus } from "@/lib/db/queries";
import { relativeTime } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";
import { GarminKeyForm } from "./garmin-key-form";
import { SyncPanel } from "./sync-panel";
import { IntervalsKeyForm, IntervalsPushControls } from "./intervals-panel";
import { WATCH_STATE } from "@/components/watch/states";
import { addDaysIso, formatDay, todayIn } from "@/lib/dates";
import { formatPace } from "@/lib/units";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "good" },
  needs_reauth: { label: "Key rejected", tone: "hr" },
  error: { label: "Error", tone: "warn" },
  not_configured: { label: "Not connected", tone: "muted" },
};

export default async function IntegrationsPage() {
  const [integration, tz] = await Promise.all([getIntegrationStatus(), userTimezone()]);
  const db = await createUserClient();
  const { data: jobs } = await db
    .from("sync_jobs")
    .select("id, kind, status, range_start, discovered, processed, failed, unavailable, skipped, last_error, created_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(5);
  const status = STATUS[integration?.status ?? "not_configured"] ?? STATUS.not_configured;
  const connected = integration?.status === "connected" || integration?.status === "error";
  const today = todayIn(tz);
  const [{ data: intervals }, { data: syncs }] = await Promise.all([
    db.from("integrations").select("status, last_success_at, last_error, settings").eq("provider", "intervals_icu").maybeSingle(),
    db
      .from("external_workout_syncs")
      .select("planned_workout_id, workout_date, state, last_error, planned_workouts(title)")
      .eq("provider", "intervals_icu")
      .gte("workout_date", today)
      .lte("workout_date", addDaysIso(today, 13))
      .neq("state", "removed")
      .order("workout_date")
      .limit(20),
  ]);
  const iStatus = STATUS[intervals?.status ?? "not_configured"] ?? STATUS.not_configured;
  const iConnected = Boolean(intervals && intervals.status !== "not_configured");
  const run = intervals?.settings?.run as { hasThresholdPace: boolean; thresholdPaceSPerKm: number | null; maxHr: number | null } | undefined;
  const summary = intervals?.settings?.lastPushSummary as { sent: number; removed: number; unchanged: number; failed: number } | undefined;
  const wellnessErrors: { source: string; message: string }[] = integration?.settings?.lastWellnessErrors ?? [];

  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Integrations" />

      <section className="card mb-3 p-5">
        <div className="mb-4 flex items-start gap-3.5">
          <IconTile color="var(--pace)">
            <Watch size={18} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Garmin Connect</p>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">Imports runs and wellness data through Garmin&apos;s official Personal API (read-only).</p>
          </div>
        </div>
        {integration?.last_success_at && (
          <p className="mb-3 text-xs text-muted">Last successful sync: {new Date(integration.last_success_at).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}</p>
        )}
        {connected && (
          <p className="mb-3 text-xs text-muted">
            Background sync every 30 minutes
            {integration?.settings?.lastScheduledRunAt ? ` · last ran ${relativeTime(integration.settings.lastScheduledRunAt)}` : " · hasn't run yet"}
          </p>
        )}
        {integration?.last_error && integration.status !== "connected" && <p className="mb-3 text-sm text-danger">{integration.last_error}</p>}
        <details open={!connected} className="group">
          <summary className="mb-3 cursor-pointer text-sm font-semibold text-accent">{connected ? "Replace API key" : "How to connect"}</summary>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted marker:font-semibold marker:text-fg-2">
            <li>
              Open{" "}
              <a className="font-medium text-accent underline underline-offset-2" href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noreferrer">
                Garmin Connect → Personal API key
              </a>
              .
            </li>
            <li>Create a key (choose the longest expiry), accept the terms and copy it. It is only shown once.</li>
            <li>Paste it below. Løype exchanges it for short-lived access tokens automatically.</li>
          </ol>
          <GarminKeyForm replacing={connected} />
        </details>
      </section>

      {connected && <SyncPanel initialJobs={jobs ?? []} />}

      {connected && wellnessErrors.length > 0 && (
        <p className="mt-3 px-1 text-xs text-muted">
          Some wellness data couldn&apos;t be fetched last time ({wellnessErrors.map((e) => e.source).join(", ")}). Runs are unaffected.
        </p>
      )}

      <section className="card mt-3 p-5">
        <div className="mb-4 flex items-start gap-3.5">
          <IconTile color="var(--accent)">
            <Send size={18} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Intervals.icu</p>
              <Badge tone={iStatus.tone}>{iStatus.label}</Badge>
            </div>
            <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
              Sends your next two weeks of planned workouts to Intervals.icu, which passes them to Garmin Connect and your watch. Kept up to date when the plan changes.
            </p>
          </div>
        </div>

        {iConnected && (
          <div className="mb-4 space-y-3">
            {intervals?.settings?.athleteName && <p className="text-xs text-muted">Signed in as {intervals.settings.athleteName}.</p>}
            {run && !run.hasThresholdPace && (
              <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
                Intervals.icu has no Run threshold pace, so pace targets wouldn&apos;t reach Garmin. Workouts are sent with heart-rate targets until you set one in Intervals.icu → Settings → Sport settings → Run.
              </p>
            )}
            {run?.hasThresholdPace && run.thresholdPaceSPerKm && <p className="text-xs text-muted">Run threshold pace in Intervals.icu: {formatPace(run.thresholdPaceSPerKm)}/km. Workouts are sent with pace targets.</p>}
            {intervals?.last_success_at && (
              <p className="text-xs text-muted">
                Last checked {new Date(intervals.last_success_at).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}
                {summary ? ` · ${summary.sent} sent, ${summary.unchanged} up to date${summary.removed ? `, ${summary.removed} removed` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}` : ""}
              </p>
            )}
            {intervals?.last_error && <p className="text-sm text-danger">{intervals.last_error}</p>}
            {syncs && syncs.length > 0 && (
              <ul className="divide-y divide-[var(--hairline)] rounded-xl bg-surface-2">
                {syncs.map((r: any) => {
                  const st = WATCH_STATE[r.state] ?? WATCH_STATE.pending;
                  return (
                    <li key={r.planned_workout_id ?? r.workout_date}>
                      <Link href={r.planned_workout_id ? `/plan/workouts/${r.planned_workout_id}` : "/plan"} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                        <span className="min-w-0 text-sm">
                          <span className="text-muted">{formatDay(r.workout_date, { weekday: "short", day: "numeric", month: "short" })}</span> · <span className="font-medium">{r.planned_workouts?.title ?? "Workout"}</span>
                        </span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs leading-relaxed text-muted">
              &quot;On Intervals.icu&quot; means Intervals.icu read every step correctly. Intervals.icu can&apos;t tell Løype whether Garmin received it, so confirm on each workout once you see it on the watch.
            </p>
            <IntervalsPushControls />
          </div>
        )}

        <details open={!iConnected} className="group">
          <summary className="mb-3 cursor-pointer text-sm font-semibold text-accent">{iConnected ? "Replace API key" : "How to connect"}</summary>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted marker:font-semibold marker:text-fg-2">
            <li>
              In{" "}
              <a className="font-medium text-accent underline underline-offset-2" href="https://intervals.icu/settings" target="_blank" rel="noreferrer">
                Intervals.icu → Settings
              </a>
              , connect Garmin and switch on <span className="font-medium text-fg-2">Upload planned workouts</span>.
            </li>
            <li>Under Sport settings → Run, set a threshold pace (needed for pace targets on Garmin).</li>
            <li>Under Developer settings, copy the API key and your athlete ID, and paste them below.</li>
          </ol>
          <IntervalsKeyForm replacing={iConnected} />
        </details>
      </section>
    </>
  );
}
