"use client";

import Link from "@/components/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, CalendarDays, LineChart, Map as MapIcon, MessageCircle, Ellipsis, Sun } from "lucide-react";
import clsx from "clsx";
import { LogoMark, Wordmark } from "./logo";
import { SyncButton } from "./sync/sync-button";

const ITEMS = [
  { href: "/", label: "Today", icon: Sun },
  { href: "/plan", label: "Plan", icon: CalendarDays },
  { href: "/progress", label: "Progress", icon: LineChart },
  { href: "/activities", label: "Activities", icon: Activity },
  { href: "/routes", label: "Routes", icon: MapIcon },
  { href: "/more", label: "More", icon: Ellipsis },
];

const COACH = { href: "/coach", label: "Coach", icon: MessageCircle };
/** Desktop shows Coach in the list; on phones it's the floating button (the bottom bar is full). */
const SIDE_ITEMS = [...ITEMS.slice(0, 5), COACH, ITEMS[5]];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

/**
 * Which tab to highlight. Switches to the tapped tab immediately, before the
 * server has answered, so the bar reacts to the tap; falls back to the URL
 * once the navigation lands.
 */
function useActiveTab() {
  const path = usePathname();
  const [tapped, setTapped] = useState<string | null>(null);
  useEffect(() => setTapped(null), [path]);
  return {
    active: (href: string) => (tapped ? tapped === href : isActive(path, href)),
    current: (href: string) => isActive(path, href),
    tap: (href: string) => setTapped(isActive(path, href) && path === href ? null : href),
  };
}

export function BottomNav() {
  const tabs = useActiveTab();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--hairline)] bg-bg/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150 md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-6 px-1">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = tabs.active(href);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={() => tabs.tap(href)}
                aria-current={tabs.current(href) ? "page" : undefined}
                className={clsx(
                  "flex flex-col items-center gap-[3px] pt-2 pb-1.5 text-[0.625rem] font-medium tracking-[0.01em] transition-colors",
                  active ? "text-fg" : "text-subtle",
                )}
              >
                <Icon size={23} strokeWidth={active ? 2.1 : 1.7} className={active ? "text-accent" : undefined} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SideNav() {
  const tabs = useActiveTab();
  return (
    <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-0.5 border-r border-[var(--hairline)] px-3 py-6 md:flex">
      <Link href="/" className="mb-7 flex items-center gap-2.5 px-3">
        <LogoMark size={28} />
        <Wordmark />
      </Link>
      {SIDE_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = tabs.active(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => tabs.tap(href)}
            aria-current={tabs.current(href) ? "page" : undefined}
            className={clsx(
              "flex min-h-10 items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-medium transition-colors",
              active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            <Icon size={19} strokeWidth={active ? 2.1 : 1.8} className={active ? "text-accent" : undefined} />
            {label}
          </Link>
        );
      })}
      <div className="mt-auto px-1">
        <SyncButton className="w-full justify-center" />
      </div>
    </nav>
  );
}

/** Phone-only shortcut to the coach, floating above the bottom bar. */
export function CoachButton() {
  const path = usePathname();
  if (path.startsWith("/coach")) return null;
  return (
    <Link
      href="/coach"
      aria-label="Coach"
      className="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex size-13 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[var(--shadow-pop)] transition active:scale-95 md:hidden"
    >
      <MessageCircle size={22} strokeWidth={2} />
    </Link>
  );
}
