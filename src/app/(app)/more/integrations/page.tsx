import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge, PageHeader } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { getIntegrationStatus } from "@/lib/db/queries";
import { userTimezone } from "@/lib/user-tz";
import { GarminKeyForm } from "./garmin-key-form";
import { SyncPanel } from "./sync-panel";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "accent" | "warn" | "hr" | "muted" }> = {
  connected: { label: "Connected", tone: "accent" },
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
      <Link href="/more" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft size={16} /> More
      </Link>
      <PageHeader title="Integrations" />

      <section className="card mb-4 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="font-display text-2xl font-semibold">Garmin Connect</p>
            <p className="text-sm text-muted">Imports runs and wellness data through Garmin&apos;s official Personal API (read-only).</p>
          </div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        {integration?.last_success_at && (
          <p className="mb-3 text-xs text-muted">Last successful sync: {new Date(integration.last_success_at).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}</p>
        )}
        {integration?.last_error && integration.status !== "connected" && <p className="mb-3 text-sm text-hr">{integration.last_error}</p>}
        <details open={!connected} className="group">
          <summary className="mb-3 cursor-pointer text-sm font-semibold text-accent">{connected ? "Replace API key" : "How to connect"}</summary>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>
              Open{" "}
              <a className="text-accent underline" href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noreferrer">
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
        <p className="mt-4 text-xs text-muted">
          Some wellness data couldn&apos;t be fetched last time ({wellnessErrors.map((e) => e.source).join(", ")}). Runs are unaffected.
        </p>
      )}

      <section className="card mt-4 p-5 opacity-80">
        <div className="flex items-center justify-between">
          <p className="font-display text-2xl font-semibold">Intervals.icu</p>
          <Badge>Not built yet</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">Will send structured workouts to your watch via Garmin Connect once training plans exist.</p>
      </section>
    </>
  );
}
