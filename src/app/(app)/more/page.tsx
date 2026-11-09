import Link from "@/components/link";
import { BookOpen, CalendarDays, ChevronRight, Compass, Download, Footprints, HeartPulse, KeyRound, Link2, LogOut, Trash2 } from "lucide-react";
import { IconTile, PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

const ROWS = [
  { href: "/more/integrations", icon: Link2, color: "var(--pace)", label: "Integrations" },
  { href: "/more/profile", icon: HeartPulse, color: "var(--hr)", label: "Athlete profile" },
  { href: "/more/shoes", icon: Footprints, color: "var(--long)", label: "Shoes" },
  { href: "/more/password", icon: KeyRound, color: "var(--tempo)", label: "Password" },
  { href: "/more/calendar", icon: CalendarDays, color: "var(--accent)", label: "Calendar" },
  { href: "/guide", icon: BookOpen, color: "var(--pace)", label: "How Løype works" },
  { href: "/welcome", icon: Compass, color: "var(--good)", label: "Guided setup" },
  { href: "/api/export", icon: Download, color: "var(--cadence)", label: "Export my data", download: true },
  { href: "/more/data", icon: Trash2, color: "var(--danger)", label: "Delete my data" },
];

export default function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <div className="card rise divide-hairline overflow-hidden">
        {ROWS.map(({ href, icon: Icon, color, label, download }) => {
          const inner = (
            <>
              <IconTile color={color}>
                <Icon size={18} />
              </IconTile>
              <p className="min-w-0 flex-1 text-[0.9375rem] font-semibold">{label}</p>
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
