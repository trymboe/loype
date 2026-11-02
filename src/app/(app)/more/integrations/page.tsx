import { Send, Watch } from "lucide-react";
import { Badge, IconTile, PageHeader, type Tone } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { getIntegrationStatus } from "@/lib/db/queries";
import { relativeTime } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";
import { GarminKeyForm } from "./garmin-key-form";
import { SyncPanel } from "./sync-panel";

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

      <section className="card mt-3 flex items-start gap-3.5 p-5">
        <IconTile>
          <Send size={18} />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[1.0625rem] font-semibold tracking-[-0.01em] text-fg-2">Intervals.icu</p>
            <Badge>Not built yet</Badge>
          </div>
          <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">Will send structured workouts to your watch via Garmin Connect once training plans exist.</p>
        </div>
      </section>
    </>
  );
}
