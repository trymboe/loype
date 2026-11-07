/**
 * Flat loops: generate loops in a few directions from the start point, look up
 * the elevation of each and keep the one with the least climbing per km that
 * is close to the target distance.
 */
import { joinSegments, elevationStats, type LngLat } from "./geometry";
import { elevationAlong } from "./elevation";
import { generateLoop, RoutingError, type LoopResult, type RoutingProvider } from "./routing";

export interface FlatLoopResult extends LoopResult {
  elevationGainM: number | null;
  candidates: number;
}

/** Lower is better: climb in m/km, with a steep penalty once the distance is more than 10 % off. */
export function flatScore(distanceM: number, targetM: number, gainM: number | null): number {
  const off = Math.abs(distanceM / targetM - 1);
  const climb = gainM != null && distanceM > 0 ? gainM / (distanceM / 1000) : 20;
  return climb + Math.max(0, off - 0.1) * 400;
}

export async function findFlatLoop(router: RoutingProvider, start: LngLat, targetM: number, bearing: number, { directions = 3 }: { directions?: number } = {}): Promise<FlatLoopResult> {
  const bearings = Array.from({ length: directions }, (_, i) => (bearing + (i * 360) / directions) % 360);
  const results = await Promise.allSettled(
    bearings.map(async (b) => {
      const loop = await generateLoop(router, start, targetM, b, { maxAttempts: 3, tolerance: 0.08 });
      let gain: number | null = null;
      try {
        gain = elevationStats(await elevationAlong(router, joinSegments(loop.legs))).gainM;
      } catch {
        // no elevation: scored as hilly, still usable
      }
      return { loop, gain, score: flatScore(loop.distanceM, targetM, gain) };
    }),
  );
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    const err = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    throw err instanceof Error ? err : new RoutingError("Couldn't find a loop from here.", "no_route");
  }
  const best = ok.reduce((a, b) => (b.score < a.score ? b : a));
  return { ...best.loop, elevationGainM: best.gain, candidates: ok.length };
}
