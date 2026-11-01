/** Calendar helpers operating on YYYY-MM-DD strings (local dates, ISO weeks starting Monday). */

export function todayIn(tz = "Europe/Oslo", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return addDaysIso(date, -dow);
}

export function formatDay(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** Local clock time of an activity, using the device's recorded UTC offset when present. */
export function localTime(startIso: string, offsetS: number | null, tz = "Europe/Oslo"): string {
  const d = new Date(startIso);
  if (offsetS != null) {
    const l = new Date(d.getTime() + offsetS * 1000);
    return `${String(l.getUTCHours()).padStart(2, "0")}:${String(l.getUTCMinutes()).padStart(2, "0")}`;
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
}
