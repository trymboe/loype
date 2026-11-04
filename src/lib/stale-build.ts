/**
 * Detects errors caused by a new deployment going live while the app is open
 * (the installed home-screen app keeps old JavaScript around). A server action
 * or page chunk from the old build no longer matches the server, and React
 * throws one of these. Reloading picks up the new build.
 */
const STALE = [
  /unexpected response was received from the server/i,
  /failed to find server action/i,
  /server action .* was not found/i,
  /UnrecognizedActionError/,
  /ChunkLoadError/i,
  /loading (css )?chunk [\w-]+ failed/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
];

export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; message?: string };
  const text = `${e.name ?? ""} ${e.message ?? String(error)}`;
  return STALE.some((re) => re.test(text));
}

const KEY = "loype:stale-reload-at";

/** Reloads once; returns false if we already reloaded in the last minute (avoids a reload loop). */
export function reloadForNewBuild(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (now - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // storage unavailable: still reload once per page life
  }
  window.location.reload();
  return true;
}
