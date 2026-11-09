import type { ReactNode } from "react";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { ShoeNotice } from "@/components/shoes/shoe-nudge";
import { WearBar } from "@/components/shoes/wear-bar";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { DEFAULT_RETIRE_M, shoeSubtitle, type ShoeMileage } from "@/lib/shoes/mileage";
import { listShoesWithMileage } from "@/lib/shoes/service";
import { formatKm } from "@/lib/units";
import { addShoeAction, setDefaultShoeAction, setRetiredAction, updateShoeAction } from "./actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export const metadata = { title: "Shoes" };
export const dynamic = "force-dynamic";

const km = (m: number | null) => (m == null ? "" : String(Math.round(m / 100) / 10));

export default async function ShoesPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const shoes = await listShoesWithMileage(await createUserClient(), user.id);
  const active = shoes.filter((s) => !s.retired_at);
  const retired = shoes.filter((s) => s.retired_at);

  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Shoes" />
      <div className="stagger space-y-3">
        <ShoeNotice shoes={shoes} />
        {active.map((s) => (
          <ShoeCard key={s.id} shoe={s} />
        ))}
        <Card>
          <CardHeader title="Add shoe" className="mb-4" />
          <form action={addShoeAction} className="space-y-4">
            <ShoeFields />
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Default</span>
              <input type="checkbox" name="is_default" className="switch" defaultChecked={!active.some((s) => s.is_default)} />
            </label>
            <SubmitButton className="btn btn-primary btn-block min-h-12">Add shoe</SubmitButton>
          </form>
        </Card>
        {retired.length > 0 && (
          <>
            <h2 className="section-title px-1 pt-3">Retired</h2>
            {retired.map((s) => (
              <ShoeCard key={s.id} shoe={s} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function ShoeCard({ shoe: s }: { shoe: ShoeMileage }) {
  const sub = shoeSubtitle(s);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title truncate">{s.name}</h2>
          {sub && <p className="mt-0.5 truncate text-[0.8125rem] text-muted">{sub}</p>}
        </div>
        {s.is_default && <Badge tone="accent">Default</Badge>}
        {s.retired_at && <Badge>Retired</Badge>}
      </div>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <span className="display text-[2.25rem]">{formatKm(s.totalM, 0)}</span>
          <span className="ml-1 text-sm font-medium text-muted">km</span>
        </div>
        <span className="tabular pb-1 text-xs text-muted">
          {s.runs} {s.runs === 1 ? "run" : "runs"} · {formatKm(s.retireAtM, 0)} km
        </span>
      </div>
      <div className="mt-3">
        <WearBar fraction={s.fraction} state={s.state} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {!s.retired_at && !s.is_default && (
          <form action={setDefaultShoeAction}>
            <input type="hidden" name="shoeId" value={s.id} />
            <SubmitButton className="btn btn-secondary btn-sm">Set as default</SubmitButton>
          </form>
        )}
        <form action={setRetiredAction}>
          <input type="hidden" name="shoeId" value={s.id} />
          <input type="hidden" name="retire" value={s.retired_at ? "0" : "1"} />
          <SubmitButton className="btn btn-secondary btn-sm">{s.retired_at ? "Bring back" : "Retire"}</SubmitButton>
        </form>
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium text-accent">Edit</summary>
        <form action={updateShoeAction} className="mt-4 space-y-4">
          <input type="hidden" name="shoeId" value={s.id} />
          <ShoeFields shoe={s} />
          <SubmitButton className="btn btn-primary btn-block">Save</SubmitButton>
        </form>
      </details>
    </Card>
  );
}

function ShoeFields({ shoe }: { shoe?: ShoeMileage }) {
  return (
    <>
      <Field label="Name">
        <input name="name" required maxLength={80} defaultValue={shoe?.name ?? ""} className="input" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Brand">
          <input name="brand" maxLength={60} defaultValue={shoe?.brand ?? ""} className="input" />
        </Field>
        <Field label="Model">
          <input name="model" maxLength={60} defaultValue={shoe?.model ?? ""} className="input" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Previous km">
          <input name="starting_km" type="number" inputMode="decimal" min={0} max={10000} step="0.1" defaultValue={km(shoe?.starting_distance_m ?? null)} placeholder="0" className="input" />
        </Field>
        <Field label="Retire at (km)">
          <input name="retire_km" type="number" inputMode="decimal" min={1} max={10000} step="1" defaultValue={km(shoe?.retire_at_distance_m ?? null)} placeholder={String(DEFAULT_RETIRE_M / 1000)} className="input" />
        </Field>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
    </label>
  );
}
