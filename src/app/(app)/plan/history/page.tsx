import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { restoreVersionAction } from "../actions";
import { createUserClient } from "@/lib/db/server";
import { formatDay } from "@/lib/dates";
import { GOAL_LABEL } from "@/lib/planning/types";

export const metadata = { title: "Plan history" };
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

const BY: Record<string, string> = { generator: "Generated", athlete: "You", adaptation: "Adaptation" };
const STATUS: Record<string, string> = { pending: "waiting for you", accepted: "accepted", rejected: "kept plan", undone: "undone", superseded: "expired" };

export default async function PlanHistoryPage() {
  const db = await createUserClient();
  const { data: plans } = await db.from("training_plans").select("id, status, created_at, current_version, goal:goals(kind, name, race_date)").order("created_at", { ascending: false });
  const ids = (plans ?? []).map((p: any) => p.id);
  const [{ data: versions }, { data: proposals }] = await Promise.all([
    ids.length ? db.from("plan_versions").select("plan_id, version, reason, created_by, created_at").in("plan_id", ids).order("version", { ascending: false }) : Promise.resolve({ data: [] as any[] }),
    ids.length ? db.from("adaptation_proposals").select("plan_id, title, status, created_at, rule").in("plan_id", ids).order("created_at", { ascending: false }) : Promise.resolve({ data: [] as any[] }),
  ]);
  return (
    <>
      <PageHeader title="Plan history" subtitle="Every change to your plan, who made it and why. Restore any earlier version." />
      <div className="space-y-4">
        <Link href="/plan" className="text-sm text-accent">
          ← Back to plan
        </Link>
        {(plans ?? []).map((p: any) => (
          <Card key={p.id}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">{p.goal?.kind === "race" && p.goal?.name ? p.goal.name : GOAL_LABEL[p.goal?.kind as keyof typeof GOAL_LABEL]}</div>
              <Badge tone={p.status === "active" ? "accent" : "muted"}>{p.status}</Badge>
            </div>
            <div className="text-xs text-muted">Created {formatDay(p.created_at.slice(0, 10))}</div>
            <ul className="mt-3 divide-y divide-border">
              {(versions ?? [])
                .filter((v: any) => v.plan_id === p.id)
                .map((v: any) => (
                  <li key={v.version} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div>
                        <span className="text-muted">v{v.version}</span> {v.reason}
                      </div>
                      <div className="text-xs text-muted">
                        {BY[v.created_by]} · {new Date(v.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                      </div>
                    </div>
                    {p.status === "active" && v.version !== p.current_version && (
                      <form action={restoreVersionAction}>
                        <input type="hidden" name="planId" value={p.id} />
                        <input type="hidden" name="version" value={v.version} />
                        <button className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold">Restore</button>
                      </form>
                    )}
                  </li>
                ))}
            </ul>
            {(proposals ?? []).some((x: any) => x.plan_id === p.id) && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">Adaptation suggestions</summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {(proposals ?? [])
                    .filter((x: any) => x.plan_id === p.id)
                    .map((x: any, i: number) => (
                      <li key={i}>
                        {formatDay(x.created_at.slice(0, 10))}: {x.title} <span className="text-muted">({STATUS[x.status]})</span>
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
