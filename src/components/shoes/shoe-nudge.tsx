import Link from "next/link";
import { ChevronRight, Footprints } from "lucide-react";
import { Badge, IconTile } from "@/components/ui";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { shoesToReplace, type ShoeMileage } from "@/lib/shoes/mileage";
import { listShoesWithMileage } from "@/lib/shoes/service";
import { formatKm } from "@/lib/units";

/** One line per active shoe at or near its retire distance. */
export function ShoeNotice({ shoes, href }: { shoes: ShoeMileage[]; href?: string }) {
  const due = shoesToReplace(shoes);
  if (!due.length) return null;
  const rows = due.map((s) => (
    <div key={s.id} className="flex items-center gap-3.5">
      <IconTile color={s.state === "due" ? "var(--danger)" : "var(--warn)"}>
        <Footprints size={18} />
      </IconTile>
      <p className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold">{s.name}</p>
      <span className="tabular shrink-0 text-xs text-muted">
        {formatKm(s.totalM, 0)} / {formatKm(s.retireAtM, 0)} km
      </span>
      <Badge tone="warn">{s.state === "due" ? "Replace" : "Replace soon"}</Badge>
      {href && <ChevronRight size={18} className="shrink-0 text-subtle" />}
    </div>
  ));
  return href ? (
    <Link href={href} className="card block space-y-3 p-4 hover:bg-surface-2/40">
      {rows}
    </Link>
  ) : (
    <section className="card space-y-3 p-4">{rows}</section>
  );
}

/** Today page: worn shoes, linking to the shoes page. Renders nothing on any error. */
export async function ShoeNudge() {
  try {
    const user = await getSessionUser();
    if (!user) return null;
    const shoes = await listShoesWithMileage(await createUserClient(), user.id);
    return <ShoeNotice shoes={shoes} href="/more/shoes" />;
  } catch {
    return null;
  }
}
