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
    maxHr: phys?.maxHr && phys.maxHr.source !== "manual" ? `${phys.maxHr.value}` : null,
    restHr: phys?.restHr && phys.restHr.source !== "manual" ? `${phys.restHr.value}` : null,
  };
  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Athlete profile" />
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
    </>
  );
}
