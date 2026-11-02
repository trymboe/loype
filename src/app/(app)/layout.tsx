import { BottomNav, SideNav } from "@/components/nav";
import { SyncProvider } from "@/components/sync/sync-provider";
import { TimezoneSync } from "@/components/timezone-sync";
import { getIntegrationStatus } from "@/lib/db/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const integration = await getIntegrationStatus().catch(() => null);
  const connected = !!integration && integration.status !== "not_configured" && integration.status !== "needs_reauth";
  return (
    <SyncProvider connected={connected} initialLastSyncedAt={integration?.last_success_at ?? null}>
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
