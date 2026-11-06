import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { RecapView } from "@/components/recap/recap-view";
import { createUserClient } from "@/lib/db/server";
import { todayIn } from "@/lib/dates";
import { userTimezone } from "@/lib/user-tz";
import type { EstimateSnapshot, WeekRecap } from "@/lib/recap/build";

export const metadata = { title: "Weekly recap" };
export const dynamic = "force-dynamic";

export default async function WeeklyRecapPage({ params }: { params: Promise<{ week: string }> }) {
  const { week } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) notFound();
  const db = await createUserClient();
  const { data } = await db.from("weekly_recaps").select("week_start, estimates, recap").eq("week_start", week).maybeSingle();
  if (!data) notFound();
  const recap = data.recap as WeekRecap;
  return (
    <>
      <PageHeader back={{ href: "/progress/weeks", label: "Weekly recaps" }} title="Week in review" />
      <RecapView recap={recap} estimates={data.estimates as EstimateSnapshot} today={todayIn(await userTimezone())} />
    </>
  );
}
