/** Sessions that no longer count toward a week's planned minutes: skipped, or missed (the red cross). */
const DROPPED = new Set(["skipped", "missed"]);

/** Planned minutes for a week on the plan page, leaving out skipped and missed sessions. */
export function plannedMinutes(items: { status: string; duration_s: number | null }[]): number {
  return items.filter((w) => !DROPPED.has(w.status)).reduce((a, w) => a + (w.duration_s ?? 0) / 60, 0);
}
