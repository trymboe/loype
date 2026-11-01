import { BottomNav, SideNav } from "@/components/nav";
import { TimezoneSync } from "@/components/timezone-sync";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <SideNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))] md:px-8 md:pb-12">
        {children}
      </main>
      <BottomNav />
      <TimezoneSync />
    </div>
  );
}
