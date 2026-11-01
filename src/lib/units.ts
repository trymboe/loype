/** Formatting helpers. All inputs are SI units (metres, seconds, m/s). */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Seconds per kilometre for a speed in m/s. Returns null for non-moving speeds. */
export function speedToPaceSecPerKm(speedMs: number | null | undefined): number | null {
  if (speedMs == null || !Number.isFinite(speedMs) || speedMs <= 0.2) return null;
  return 1000 / speedMs;
}

export function formatPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return "–";
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm - m * 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPaceFromSpeed(speedMs: number | null | undefined): string {
  return formatPace(speedToPaceSecPerKm(speedMs));
}

export function formatKm(metres: number | null | undefined, digits = 2): string {
  if (metres == null || !Number.isFinite(metres)) return "–";
  return (metres / 1000).toFixed(digits);
}
