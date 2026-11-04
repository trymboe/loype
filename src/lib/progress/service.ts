import "server-only";
import { fetchAll } from "../db/paginate";
import { createUserClient } from "../db/server";
import { getFitnessState, getVdotHistory } from "../db/queries";
import { computeMilestones, type MilestoneRun, type VdotPoint } from "./milestones";
import { payingOff } from "./paying-off";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Runs with their best efforts (only from runs whose GPS pace is trustworthy). */
export async function loadMilestoneRuns(): Promise<MilestoneRun[]> {
  const db = await createUserClient();
  const [acts, feats] = await Promise.all([
    fetchAll<any>((from, to) =>
      db
        .from("activities")
        .select("id, local_date, distance_m, moving_s, quality")
        .eq("sport", "running")
        .is("duplicate_of", null)
        .order("start_time")
        .order("id")
        .range(from, to),
    ),
    fetchAll<any>((from, to) => db.from("activity_features").select("activity_id, best:features->bestEfforts").order("activity_id").range(from, to)),
  ]);
  const best = new Map<string, any[]>(feats.map((f) => [f.activity_id, Array.isArray(f.best) ? f.best : []]));
  return acts.map((a) => ({
    id: a.id,
    date: a.local_date,
    distanceM: a.distance_m,
    movingS: a.moving_s,
    bestEfforts: a.quality?.paceReliable === false ? [] : (best.get(a.id) ?? []).map((e: any) => ({ distanceM: e.distanceM, timeS: e.timeS })),
  }));
}

/** Weekly VDOT history from retrospective snapshots, plus today's value. */
export function vdotSeries(rows: { as_of: string; kind: string; value: number | null }[]): VdotPoint[] {
  const byDate = new Map<string, number | null>();
  for (const r of rows) if (r.kind === "retrospective") byDate.set(r.as_of, r.value);
  const lastRetro = [...byDate.keys()].sort().at(-1) ?? "";
  const latest = rows.filter((r) => r.kind === "contemporaneous" && r.as_of > lastRetro).sort((a, b) => a.as_of.localeCompare(b.as_of)).at(-1);
  if (latest) byDate.set(latest.as_of, latest.value);
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Everything the progress-motivation UI needs, from the stored fitness model and runs. */
export async function loadProgressMotivation(
  today: string,
  fitness?: Awaited<ReturnType<typeof getFitnessState>>,
  vdotRows?: Awaited<ReturnType<typeof getVdotHistory>>,
) {
  const state = fitness === undefined ? await getFitnessState() : fitness;
  const [runs, vrows] = await Promise.all([loadMilestoneRuns(), vdotRows ?? (state ? getVdotHistory(state.model_version) : Promise.resolve([]))]);
  const vdot = vdotSeries(vrows);
  const ef = ((state?.output?.efficiency?.points ?? []) as { date: string; ef: number }[]).map((p) => ({ date: p.date, ef: p.ef }));
  return {
    milestones: computeMilestones(runs, vdot, today),
    payoff: payingOff({ runs, vdot, ef, today }),
    fitness: state,
  };
}
