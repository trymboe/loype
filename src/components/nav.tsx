"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, CalendarDays, LineChart, MessageCircle, Menu, Sun } from "lucide-react";
import clsx from "clsx";

const ITEMS = [
  { href: "/", label: "Today", icon: Sun },
  { href: "/plan", label: "Plan", icon: CalendarDays },
  { href: "/progress", label: "Progress", icon: LineChart },
  { href: "/activities", label: "Activities", icon: Activity },
  { href: "/coach", label: "Coach", icon: MessageCircle },
  { href: "/more", label: "More", icon: Menu },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      <ul className="mx-auto grid max-w-lg grid-cols-6">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(path, href);
          return (
            <li key={href}>
              <Link
                href={href}
                className={clsx(
                  "flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                  active ? "text-accent" : "text-muted",
                )}
              >
                <Icon size={21} strokeWidth={active ? 2.4 : 1.8} />
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
  const path = usePathname();
  return (
    <nav className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-1 border-r border-border px-3 py-6 md:flex">
      <Link href="/" className="mb-6 px-3 font-display text-3xl font-bold tracking-tight">
        Løype
      </Link>
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
            )}
          >
            <Icon size={18} className={active ? "text-accent" : undefined} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
