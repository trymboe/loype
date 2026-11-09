import Link from "@/components/link";
import { AlertTriangle, ChevronRight } from "lucide-react";

/** Surfaces integration problems wherever the user is, so failures are never silent. */
export function SyncBanner({
  integration,
  strava,
}: {
  integration: { status: string; last_error?: string | null; api_key_expires_at?: string | null } | null;
  strava?: { status: string; last_error?: string | null } | null;
}) {
  let msg: string | null = null;
  if (strava?.status === "needs_reauth") msg = "Strava stopped giving Løype access to your runs. Reconnect Strava to resume syncing.";
  else if (strava?.status === "error") msg = `Last Strava sync failed: ${strava.last_error ?? "unknown error"}`;
  if (msg) return <Banner msg={msg} />;
  if (!integration || integration.status === "not_configured") return null;
  if (integration.status === "needs_reauth") msg = "Garmin rejected your Personal API key. Create a new key to resume syncing.";
  else if (integration.status === "error") msg = `Last Garmin sync failed: ${integration.last_error ?? "unknown error"}`;
  else if (integration.api_key_expires_at) {
    const days = Math.ceil((Date.parse(integration.api_key_expires_at) - Date.now()) / 86400_000);
    if (days <= 14) msg = days <= 0 ? "Your Garmin API key has expired." : `Your Garmin API key expires in ${days} day${days === 1 ? "" : "s"}.`;
  }
  if (!msg) return null;
  return <Banner msg={msg} />;
}

function Banner({ msg }: { msg: string }) {
  return (
    <Link href="/more/integrations" className="rise mb-4 flex items-center gap-3 rounded-2xl bg-warn/10 p-4 text-sm ring-1 ring-warn/25 ring-inset">
      <AlertTriangle size={18} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 leading-snug">{msg}</span>
      <span className="inline-flex shrink-0 items-center font-semibold text-warn">
        Fix <ChevronRight size={16} />
      </span>
    </Link>
  );
}
