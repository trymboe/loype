/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { Activity, Send, Watch } from "lucide-react";
import { Badge, IconTile, PageHeader, type Tone } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { getIntegrationStatus, getStravaStatus } from "@/lib/db/queries";
import { StravaAppForm, StravaControls } from "./strava-panel";
import { headers } from "next/headers";
import { userTimezone } from "@/lib/user-tz";
import { GarminKeyForm } from "./garmin-key-form";
import { SyncPanel } from "./sync-panel";
import { ApplyThresholdButton, IntervalsKeyForm, IntervalsPushControls } from "./intervals-panel";
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

const STRAVA_STATUS: Record<string, { label: string; tone: Tone }> = {
  ...STATUS,
  needs_reauth: { label: "Needs reconnect", tone: "hr" },
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [integration, strava, tz, sp, h] = await Promise.all([getIntegrationStatus(), getStravaStatus(), userTimezone(), searchParams, headers()]);
  const callbackDomain = (h.get("x-forwarded-host") ?? h.get("host") ?? "loype.vercel.app").split(":")[0];
  const stravaFlash = typeof sp.strava === "string" ? sp.strava : null;
  const stravaFlashError = typeof sp.strava_error === "string" ? sp.strava_error : null;
  const db = await createUserClient();
  const { data: jobs } = await db
    .from("sync_jobs")
    .select("id, kind, provider, status, range_start, discovered, processed, failed, unavailable, skipped, last_error, created_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(5);
  const status = STATUS[integration?.status ?? "not_configured"] ?? STATUS.not_configured;
  const connected = integration?.status === "connected" || integration?.status === "error";
  const sStatus = STRAVA_STATUS[strava?.status ?? "not_configured"] ?? STRAVA_STATUS.not_configured;
  const sConnected = Boolean(strava && strava.status !== "not_configured");
  const sSettings = (strava?.settings ?? {}) as { athleteName?: string | null; webhookId?: number | null; webhookError?: string };
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
  const { data: tSnap } = await db.from("fitness_snapshots").select("value").eq("metric", "threshold_pace").eq("kind", "contemporaneous").order("as_of", { ascending: false }).limit(1).maybeSingle();
  const thresholds = { paceSPerKm: typeof tSnap?.value === "number" ? Math.round(tSnap.value) : null };
  const iStatus = STATUS[intervals?.status ?? "not_configured"] ?? STATUS.not_configured;
  const iConnected = Boolean(intervals && intervals.status !== "not_configured");
  const run = intervals?.settings?.run as { hasThresholdPace: boolean; thresholdPaceSPerKm: number | null; maxHr: number | null } | undefined;
  const summary = intervals?.settings?.lastPushSummary as { sent: number; removed: number; unchanged: number; failed: number } | undefined;
  const wellnessErrors: { source: string; message: string }[] = integration?.settings?.lastWellnessErrors ?? [];

  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Integrations" />

      <section className="card mb-3 p-5">
        <div className="mb-4 flex items-center gap-3.5">
          <IconTile color="var(--pace)">
            <Watch size={18} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Garmin Connect</p>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          </div>
        </div>
        {integration?.last_success_at && (
          <p className="mb-3 text-xs text-muted">Last sync {new Date(integration.last_success_at).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}</p>
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
            <li>Paste it below.</li>
          </ol>
          <GarminKeyForm replacing={connected} />
        </details>
      </section>

      <section id="strava" className="card mb-3 scroll-mt-6 p-5">
        <div className="mb-4 flex items-center gap-3.5">
          <IconTile color="var(--hr)">
            <Activity size={18} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Strava</p>
              <Badge tone={sStatus.tone}>{sStatus.label}</Badge>
            </div>
          </div>
        </div>
        {stravaFlash && (
          <p className="mb-3 rounded-xl bg-good/10 px-3 py-2 text-sm text-good">
            Strava connected.{" "}
            <Link href="/welcome" className="font-semibold underline underline-offset-2">
              Continue setup
            </Link>
          </p>
        )}
        {stravaFlashError && <p className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{stravaFlashError}</p>}
        {sConnected && (
          <div className="mb-4 space-y-2">
            {sSettings.athleteName && <p className="text-xs text-muted">Signed in as {sSettings.athleteName}</p>}
            {strava?.last_success_at && (
              <p className="text-xs text-muted">Last sync {new Date(strava.last_success_at).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}</p>
            )}
            {strava?.last_error && strava.status !== "connected" && <p className="text-sm text-danger">{strava.last_error}</p>}
            <StravaControls canReconnect />
          </div>
        )}
        <details open={!sConnected} className="group">
          <summary className="mb-3 cursor-pointer text-sm font-semibold text-accent">{sConnected ? "Use a different Strava app" : "How to connect"}</summary>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted marker:font-semibold marker:text-fg-2">
            <li>
              Apple Watch: in the Strava iPhone app go to You → Settings → Applications, Services and Devices → Health, and connect it so workouts are uploaded
              automatically.
            </li>
            <li>
              Open{" "}
              <a className="font-medium text-accent underline underline-offset-2" href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">
                strava.com/settings/api
              </a>{" "}
              and create an app (any name and category, website {`https://${callbackDomain}`}).
            </li>
            <li>
              Set <span className="font-medium text-fg-2">Authorization Callback Domain</span> to <span className="font-mono text-fg-2">{callbackDomain}</span>.
            </li>
            <li>Paste the Client ID and Client Secret below.</li>
          </ol>
          <StravaAppForm replacing={sConnected} />
        </details>
      </section>

      {(connected || sConnected) && <SyncPanel initialJobs={jobs ?? []} />}

      {connected && wellnessErrors.length > 0 && (
        <p className="mt-3 px-1 text-xs text-muted">
          Couldn&apos;t fetch some wellness data: {wellnessErrors.map((e) => e.source).join(", ")}
        </p>
      )}

      <section className="card mt-3 p-5">
        <div className="mb-4 flex items-center gap-3.5">
          <IconTile color="var(--accent)">
            <Send size={18} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Intervals.icu</p>
              <Badge tone={iStatus.tone}>{iStatus.label}</Badge>
            </div>
          </div>
        </div>

        {iConnected && (
          <div className="mb-4 space-y-3">
            {intervals?.settings?.athleteName && <p className="text-xs text-muted">Signed in as {intervals.settings.athleteName}</p>}
            {run && !run.hasThresholdPace && (
              <div className="space-y-2.5 rounded-xl bg-warn/10 px-3 py-3">
                <p className="text-xs leading-snug text-warn">
                  No Run threshold pace in Intervals.icu, so workouts reach Garmin without pace targets.
                  {thresholds.paceSPerKm ? "" : " Set one in Intervals.icu → Settings → Run."}
                </p>
                {thresholds.paceSPerKm && <ApplyThresholdButton pace={formatPace(thresholds.paceSPerKm)} />}
              </div>
            )}
            {run?.hasThresholdPace && run.thresholdPaceSPerKm && <p className="text-xs text-muted">Threshold pace {formatPace(run.thresholdPaceSPerKm)}/km</p>}
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
            <li>Under Sport settings → Run, set a threshold pace.</li>
            <li>Under Developer settings, copy the API key and your athlete ID, and paste them below.</li>
          </ol>
          <IntervalsKeyForm replacing={iConnected} />
        </details>
      </section>
    </>
  );
}
