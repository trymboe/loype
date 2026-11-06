import { Download } from "lucide-react";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui";
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
      <PageHeader back={{ href: "/more", label: "More" }} title="Your data" />
      <div className="stagger space-y-3">
        <Card>
          <CardHeader title="Stored in Løype" />
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat size="md" label="Activities" value={activities} />
            <Stat size="md" label="Plans" value={plans} />
            <Stat size="md" label="Wellness days" value={wellness} />
          </div>
          <a href="/api/export" className="btn btn-secondary btn-block mt-4">
            <Download size={16} />
            Export everything
          </a>
        </Card>

        <Card>
          <CardHeader title="Delete training data" />
          <p className="mt-2 mb-4 text-sm leading-relaxed text-muted">Runs, wellness, estimates and plans. Profile and connections stay.</p>
          <DeleteForm scope="training" label="Delete training data" />
        </Card>

        <Card>
          <CardHeader title="Delete everything" />
          <p className="mt-2 mb-4 text-sm leading-relaxed text-danger">This can&apos;t be undone.</p>
          <DeleteForm scope="everything" label="Delete everything" />
        </Card>
      </div>
    </>
  );
}
