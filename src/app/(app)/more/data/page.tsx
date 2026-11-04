import { Download } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { createUserClient } from "@/lib/db/server";
import { DeleteForm } from "./delete-form";

export const metadata = { title: "Your data" };
export const dynamic = "force-dynamic";

async function count(table: string) {
  const db = await createUserClient();
  const { count: n } = await db.from(table).select("*", { count: "exact", head: true });
  return n ?? 0;
}

export default async function DataPage() {
  const [activities, plans, wellness] = await Promise.all([count("activities"), count("training_plans"), count("wellness_daily")]);
  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Your data" subtitle="Download it, or delete it from Løype for good" />
      <div className="stagger space-y-3">
        <Card>
          <CardHeader title="What Løype stores" />
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {activities} {activities === 1 ? "activity" : "activities"} with their original Garmin files, {plans} training {plans === 1 ? "plan" : "plans"}{" "}
            with their history, {wellness} days of wellness data, plus fitness estimates, check-ins and sync logs derived from them. Nothing is shared with
            anyone. Your Garmin account itself is never changed: Løype only has read access.
          </p>
          <a href="/api/export" className="btn btn-secondary btn-block mt-4">
            <Download size={16} />
            Export everything first
          </a>
        </Card>

        <Card>
          <CardHeader title="Delete training data" />
          <p className="mt-2 mb-4 text-sm leading-relaxed text-muted">
            Removes all activities and original files, wellness data, fitness estimates, plans, goals and check-ins. Keeps your athlete profile, the Garmin
            connection and your calendar link, so you can import history again straight away.
          </p>
          <DeleteForm scope="training" label="Delete training data" />
        </Card>

        <Card>
          <CardHeader title="Delete everything" />
          <p className="mt-2 mb-4 text-sm leading-relaxed text-muted">
            All of the above, plus your athlete profile, the stored Garmin key and tokens, and the calendar link. You stay signed in; setting up again starts
            from scratch. This can&apos;t be undone.
          </p>
          <DeleteForm scope="everything" label="Delete everything" />
        </Card>
      </div>
    </>
  );
}
