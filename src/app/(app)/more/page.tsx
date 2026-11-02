import Link from "next/link";
import { ChevronRight, Download, KeyRound, Link2, LogOut } from "lucide-react";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

const ROWS = [
  { href: "/more/integrations", icon: Link2, label: "Integrations", hint: "Garmin Connect, sync and history import" },
  { href: "/more/password", icon: KeyRound, label: "Password", hint: "Set a password to sign in on new browsers and the home-screen app" },
  { href: "/api/export", icon: Download, label: "Export my data", hint: "Download activities, laps, splits, check-ins and wellness as JSON", download: true },
];

export default function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <div className="card divide-y divide-border">
        {ROWS.map(({ href, icon: Icon, label, hint, download }) => {
          const inner = (
            <>
              <Icon size={20} className="text-muted" />
              <div className="flex-1">
                <p className="font-semibold">{label}</p>
                <p className="text-xs text-muted">{hint}</p>
              </div>
              <ChevronRight size={18} className="text-muted" />
            </>
          );
          return download ? (
            <a key={href} href={href} className="flex items-center gap-4 p-4 hover:bg-surface-2">
              {inner}
            </a>
          ) : (
            <Link key={href} href={href} className="flex items-center gap-4 p-4 hover:bg-surface-2">
              {inner}
            </Link>
          );
        })}
        <form action="/auth/signout" method="post">
          <button className="flex w-full items-center gap-4 p-4 text-left hover:bg-surface-2">
            <LogOut size={20} className="text-muted" />
            <span className="font-semibold">Sign out</span>
          </button>
        </form>
      </div>
      <p className="mt-6 text-center text-xs text-muted">Routes, athlete profile and settings arrive in later phases.</p>
    </>
  );
}
