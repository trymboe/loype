/**
 * Soft-surface loops: generate several candidate loops with trail-leaning
 * costing, from the start point and (optionally) from other start points
 * within a walkable radius, measure the surface of each by map matching, and
 * keep the softest one that is close to the target distance.
 */
import { densify, destination, joinSegments, segmentLength, type LngLat } from "./geometry";
import { generateLoop, RoutingError, SOFT_COSTING, type LoopResult, type RoutingProvider } from "./routing";
import type { SurfaceSummary } from "./surface";

export interface SoftLoopResult extends LoopResult {
  surface: SurfaceSummary | null;
  /** Walk from the requested point to the loop start, when the loop starts elsewhere. */
  approach: { coords: LngLat[]; distanceM: number } | null;
  /** How many candidate loops were compared. */
  candidates: number;
}

export interface Candidate {
  start: LngLat;
  bearing: number;
}

/**
 * Start points and loop directions to try. Without a radius: four directions
 * from the point. With one: two from the point plus four starts spread around
 * it, each looping away from the point so they explore different ground.
 */
export function softCandidates(origin: LngLat, bearing: number, radiusM: number): Candidate[] {
  const norm = (b: number) => ((b % 360) + 360) % 360;
  if (radiusM < 100) return [0, 90, 180, 270].map((d) => ({ start: origin, bearing: norm(bearing + d) }));
  const out: Candidate[] = [
    { start: origin, bearing: norm(bearing) },
    { start: origin, bearing: norm(bearing + 180) },
  ];
  for (const d of [45, 135, 225, 315]) {
    const b = norm(bearing + d);
    out.push({ start: destination(origin, b, radiusM * 0.75), bearing: b });
  }
  return out;
}

/** Higher is better: soft share, with a steep penalty once the distance is more than 10 % off. */
export function softScore(distanceM: number, targetM: number, softPct: number | null): number {
  const off = Math.abs(distanceM / targetM - 1);
  return (softPct ?? 0) - Math.max(0, off - 0.1) * 400;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function findSoftLoop(
  router: RoutingProvider,
  origin: LngLat,
  targetM: number,
  bearing: number,
  radiusM = 0,
  { concurrency = 2, deadlineMs = 40_000 }: { concurrency?: number; deadlineMs?: number } = {},
): Promise<SoftLoopResult> {
  const until = Date.now() + deadlineMs;
  const cands = softCandidates(origin, bearing, radiusM);
  const results = await pool(cands, concurrency, async (c) => {
    if (Date.now() > until) throw new RoutingError("Out of time", "unavailable");
    const loop = await generateLoop(router, c.start, targetM, c.bearing, { maxAttempts: 3, tolerance: 0.08, costing: SOFT_COSTING });
    let surface: SurfaceSummary | null = null;
    try {
      surface = await router.surfaces(densify(joinSegments(loop.legs), 40));
    } catch {
      // unmatched loop: still usable, just scored as 0 % soft
    }
    return { loop, surface, score: softScore(loop.distanceM, targetM, surface?.softPct ?? null) };
  });
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    const err = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    throw err instanceof Error ? err : new RoutingError("Couldn't find a loop from here.", "no_route");
  }
  const best = ok.reduce((a, b) => (b.score > a.score ? b : a));
  const loopStart = best.loop.legs[0]?.[0] ?? best.loop.waypoints[0];
  let approach: SoftLoopResult["approach"] = null;
  if (segmentLength(origin, loopStart) > 50) {
    try {
      const walk = await router.route([origin, loopStart]);
      approach = { coords: walk.legs[0] ?? [origin, loopStart], distanceM: walk.distanceM };
    } catch {
      approach = { coords: [origin, loopStart], distanceM: segmentLength(origin, loopStart) };
    }
  }
  return { ...best.loop, surface: best.surface, approach, candidates: ok.length };
}
