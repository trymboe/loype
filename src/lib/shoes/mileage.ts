/** Shoe mileage and wear, kept free of I/O so it can be tested directly. */

/** Retire target when the athlete has not set one. */
export const DEFAULT_RETIRE_M = 700_000;
/** Share of the target at which the shoe is flagged as close to done. */
export const NEAR_FRACTION = 0.9;

export interface ShoeRow {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  starting_distance_m: number | null;
  retire_at_distance_m: number | null;
  is_default: boolean;
  retired_at: string | null;
  created_at: string;
}

export interface ShoeRun {
  shoe_id: string | null;
  distance_m: number | null;
  duplicate_of?: string | null;
}

export type WearState = "ok" | "near" | "due";

export interface ShoeMileage extends ShoeRow {
  totalM: number;
  runs: number;
  retireAtM: number;
  /** total / target, unclamped */
  fraction: number;
  state: WearState;
}

export const retireTarget = (s: Pick<ShoeRow, "retire_at_distance_m">) =>
  s.retire_at_distance_m && s.retire_at_distance_m > 0 ? s.retire_at_distance_m : DEFAULT_RETIRE_M;

export function wearState(totalM: number, retireAtM: number): WearState {
  if (totalM >= retireAtM) return "due";
  if (totalM >= retireAtM * NEAR_FRACTION) return "near";
  return "ok";
}

/** Previous km plus every non-duplicate run linked to the shoe. */
export function shoeMileage(shoes: ShoeRow[], runs: ShoeRun[]): ShoeMileage[] {
  const sum = new Map<string, { m: number; n: number }>();
  for (const r of runs) {
    if (!r.shoe_id || r.duplicate_of) continue;
    const s = sum.get(r.shoe_id) ?? { m: 0, n: 0 };
    s.m += r.distance_m ?? 0;
    s.n += 1;
    sum.set(r.shoe_id, s);
  }
  return shoes.map((shoe) => {
    const linked = sum.get(shoe.id) ?? { m: 0, n: 0 };
    const totalM = (shoe.starting_distance_m ?? 0) + linked.m;
    const retireAtM = retireTarget(shoe);
    return { ...shoe, totalM, runs: linked.n, retireAtM, fraction: totalM / retireAtM, state: wearState(totalM, retireAtM) };
  });
}

/** Active shoes at or past the near threshold, most worn first. */
export function shoesToReplace(shoes: ShoeMileage[]): ShoeMileage[] {
  return shoes.filter((s) => !s.retired_at && s.state !== "ok").sort((a, b) => b.fraction - a.fraction);
}

/**
 * Shoe for a newly ingested run: the active default, and only for runs that
 * started after the shoe was added (earlier runs are covered by previous km,
 * so a historical import never double counts).
 */
export function defaultShoeFor(shoes: Pick<ShoeRow, "id" | "is_default" | "retired_at" | "created_at">[], start: Date): string | null {
  const d = shoes.find((s) => s.is_default && !s.retired_at);
  if (!d) return null;
  return start.getTime() >= new Date(d.created_at).getTime() ? d.id : null;
}

export const shoeSubtitle = (s: Pick<ShoeRow, "brand" | "model">) => [s.brand, s.model].filter(Boolean).join(" ");
