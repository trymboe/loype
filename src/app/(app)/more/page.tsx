import Link from "next/link";
import { CalendarDays, ChevronRight, Compass, Download, HeartPulse, KeyRound, Link2, LogOut, Trash2 } from "lucide-react";
import { IconTile, PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

const ROWS = [
  { href: "/more/integrations", icon: Link2, color: "var(--pace)", label: "Integrations", hint: "Garmin Connect, sync and history import" },
  { href: "/more/profile", icon: HeartPulse, color: "var(--hr)", label: "Athlete profile", hint: "Max and resting heart rate, birth year, sex" },
  { href: "/more/password", icon: KeyRound, color: "var(--tempo)", label: "Password", hint: "Set a password to sign in on new browsers and the home-screen app" },
  { href: "/more/calendar", icon: CalendarDays, color: "var(--accent)", label: "Calendar", hint: "Subscribe to your plan in Google, Apple or Outlook calendar" },
  { href: "/welcome", icon: Compass, color: "var(--good)", label: "Guided setup", hint: "Garmin, history import, baseline, training background and goal" },
  { href: "/api/export", icon: Download, color: "var(--cadence)", label: "Export my data", hint: "Download activities, laps, splits, check-ins and wellness as JSON", download: true },
  { href: "/more/data", icon: Trash2, color: "var(--danger)", label: "Delete my data", hint: "Remove training data or everything Løype stores" },
];

export default function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <div className="card rise divide-hairline overflow-hidden">
        {ROWS.map(({ href, icon: Icon, color, label, hint, download }) => {
          const inner = (
            <>
              <IconTile color={color}>
                <Icon size={18} />
              </IconTile>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-semibold">{label}</p>
                <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">{hint}</p>
              </div>
              <ChevronRight size={18} className="shrink-0 text-subtle" />
            </>
          );
          const cls = "flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-surface-2/50 active:bg-surface-2";
          return download ? (
            <a key={href} href={href} className={cls}>
              {inner}
            </a>
          ) : (
            <Link key={href} href={href} className={cls}>
              {inner}
            </Link>
          );
        })}
      </div>
      <form action="/auth/signout" method="post" className="mt-3">
        <button className="card flex w-full items-center justify-center gap-2 px-4 py-3.5 text-[0.9375rem] font-semibold text-danger transition-colors hover:bg-surface-2/50">
          <LogOut size={18} />
          Sign out
        </button>
      </form>
    </>
  );
}
