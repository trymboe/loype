import { BottomNav, SideNav } from "@/components/nav";
import { TimezoneSync } from "@/components/timezone-sync";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <SideNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-32 pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.75rem))] md:px-10 md:pt-10 md:pb-16">
        {children}
      </main>
      <BottomNav />
      <TimezoneSync />
    </div>
  );
}
