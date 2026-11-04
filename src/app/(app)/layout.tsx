import { BottomNav, SideNav } from "@/components/nav";
import { SyncProvider } from "@/components/sync/sync-provider";
import { TimezoneSync } from "@/components/timezone-sync";
import { getIntegrationStatus, getStravaStatus } from "@/lib/db/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [garmin, strava] = await Promise.all([getIntegrationStatus().catch(() => null), getStravaStatus().catch(() => null)]);
  const usable = (i: { status: string } | null) => !!i && i.status !== "not_configured" && i.status !== "needs_reauth";
  const connected = usable(garmin) || usable(strava);
  const lastSyncedAt = [garmin?.last_success_at, strava?.last_success_at].filter(Boolean).sort().at(-1) ?? null;
  return (
    <SyncProvider connected={connected} initialLastSyncedAt={lastSyncedAt}>
      <div className="flex min-h-dvh">
        <SideNav />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-32 pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.75rem))] md:px-10 md:pt-10 md:pb-16">
          {children}
        </main>
        <BottomNav />
        <TimezoneSync />
      </div>
    </SyncProvider>
  );
}
