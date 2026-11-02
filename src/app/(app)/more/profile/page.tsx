import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { getFitnessState } from "@/lib/db/queries";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Athlete profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const db = await createUserClient();
  const [{ data: profile }, state] = await Promise.all([
    db.from("athlete_profile").select("max_hr, max_hr_source, resting_hr, resting_hr_source, birth_year, sex, weight_kg").maybeSingle(),
    getFitnessState(),
  ]);
  const phys = state?.output?.physiology;
  const detected = {
    maxHr: phys?.maxHr && phys.maxHr.source !== "manual" ? `${phys.maxHr.value} bpm (${phys.maxHr.note})` : null,
    restHr: phys?.restHr && phys.restHr.source !== "manual" ? `${phys.restHr.value} bpm (${phys.restHr.note})` : null,
  };
  return (
    <>
      <Link href="/more" className="mb-2 inline-flex items-center gap-1 text-sm text-muted">
        <ChevronLeft size={16} /> More
      </Link>
      <PageHeader title="Athlete profile" subtitle="Corrections here override what Løype detects" />
      <div className="card p-5">
        <ProfileForm
          initial={{
            max_hr: profile?.max_hr_source === "manual" ? profile.max_hr : null,
            resting_hr: profile?.resting_hr_source === "manual" ? profile.resting_hr : null,
            birth_year: profile?.birth_year ?? null,
            sex: profile?.sex ?? null,
            weight_kg: profile?.weight_kg ?? null,
          }}
          detected={detected}
        />
      </div>
      <p className="mt-4 text-xs text-muted">
        Max heart rate matters most: zones, training load and the fitness estimate all scale with it. If you know it from an all-out effort or a lab test, enter it.
      </p>
    </>
  );
}
