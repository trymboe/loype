/**
 * iCalendar (RFC 5545) feed for planned workouts. Pure: no I/O, no clock
 * except the `now` passed in, so the output is reproducible and testable.
 */
import type { Step } from "../planning/types";

export interface FeedWorkout {
  id: string;
  date: string; // YYYY-MM-DD, athlete's local date
  type: string;
  title: string;
  objective: string;
  why: string;
  steps: Step[];
  durationS: number;
  distanceM: number | null;
  key: boolean;
  status: "planned" | "completed" | "skipped" | "missed";
  updatedAt: string | null;
}

export interface FeedRace {
  id: string;
  name: string;
  date: string;
  distanceM: number | null;
  targetTimeS: number | null;
}

export interface FeedOptions {
  /** absolute base URL of the app, for links back to each workout */
  appUrl: string;
  /** local clock time for timed events, "HH:MM"; null gives all-day events */
  startTime: string | null;
  /** IANA zone the start time is in (required with startTime) */
  timezone: string | null;
  now: Date;
}

const CRLF = "\r\n";

/** Escapes TEXT values (RFC 5545 §3.3.11). */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line to at most 75 octets per line (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

const ymd = (date: string) => date.replace(/-/g, "");

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function fmtMin(s: number): string {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`;
}

function fmtStepAmount(s: Exclude<Step, { kind: "repeat" }>): string {
  if (s.distanceM) return `${(s.distanceM / 1000).toFixed(1)} km`;
  const t = s.durationS ?? 0;
  return t >= 120 ? `${Math.round(t / 60)} min` : t % 60 === 0 && t >= 60 ? `${t / 60} min` : `${Math.round(t)} s`;
}

const KIND: Record<string, string> = { warmup: "Warm-up", cooldown: "Cool-down", run: "Run", recover: "Recover" };

/** Plain-text outline of a workout's steps, one line each, repeats indented. */
export function describeSteps(steps: Step[], indent = ""): string[] {
  const lines: string[] = [];
  for (const s of steps) {
    if (s.kind === "repeat") {
      lines.push(`${indent}${s.count}× repeat:`);
      lines.push(...describeSteps(s.steps, `${indent}  `));
    } else {
      lines.push(`${indent}${KIND[s.kind] ?? s.kind} ${fmtStepAmount(s)}: ${s.target.label}${s.note ? ` (${s.note})` : ""}`);
    }
  }
  return lines;
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function summaryFor(w: FeedWorkout): string {
  const prefix = w.status === "completed" ? "✓ " : w.status === "missed" ? "Missed: " : "";
  const len = w.durationS > 0 ? ` · ${fmtMin(w.durationS)}` : "";
  return `${prefix}${w.title}${len}`;
}

function eventTiming(date: string, durationS: number, opts: FeedOptions): string[] {
  if (opts.startTime && opts.timezone) {
    const [h, m] = opts.startTime.split(":");
    const mins = Math.max(15, Math.round(durationS / 60));
    return [`DTSTART;TZID=${opts.timezone}:${ymd(date)}T${h}${m}00`, `DURATION:PT${mins}M`];
  }
  return [`DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(addDay(date))}`];
}

/** Builds the VCALENDAR text. Skipped workouts and rest days are left out. */
export function buildCalendar(workouts: FeedWorkout[], races: FeedRace[], opts: FeedOptions): string {
  const stamp = utcStamp(opts.now);
  const base = opts.appUrl.replace(/\/$/, "");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Løype//Training plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Løype training",
    "X-WR-CALDESC:Planned workouts from your Løype training plan",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  if (opts.timezone) lines.push(`X-WR-TIMEZONE:${opts.timezone}`);

  const sorted = [...workouts].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const w of sorted) {
    if (w.status === "skipped" || w.type === "rest") continue;
    const url = `${base}/plan/workouts/${w.id}`;
    const desc = [
      w.objective,
      w.steps.length ? ["", ...describeSteps(w.steps)].join("\n") : "",
      w.distanceM ? `\nAbout ${(w.distanceM / 1000).toFixed(1)} km.` : "",
      w.why ? `\nWhy: ${w.why}` : "",
      `\n${url}`,
    ]
      .filter(Boolean)
      .join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:workout-${w.id}@loype`,
      `DTSTAMP:${stamp}`,
      ...(w.updatedAt ? [`LAST-MODIFIED:${utcStamp(new Date(w.updatedAt))}`] : []),
      ...eventTiming(w.date, w.durationS, opts),
      `SUMMARY:${escapeText(summaryFor(w))}`,
      `DESCRIPTION:${escapeText(desc)}`,
      `URL:${url}`,
      `CATEGORIES:${escapeText(w.key ? "Running,Key session" : "Running")}`,
      "TRANSP:TRANSPARENT",
      ...(w.status === "completed" ? ["STATUS:CONFIRMED"] : []),
      "END:VEVENT",
    );
  }
  const raceDays = new Set(sorted.filter((w) => w.type === "race" && w.status !== "skipped").map((w) => w.date));
  for (const r of races) {
    if (raceDays.has(r.date)) continue; // the plan already has the race as a workout
    const bits = [r.distanceM ? `${(r.distanceM / 1000).toFixed(r.distanceM % 1000 ? 1 : 0)} km` : null, r.targetTimeS ? `target ${fmtTime(r.targetTimeS)}` : null].filter(Boolean);
    lines.push(
      "BEGIN:VEVENT",
      `UID:race-${r.id}@loype`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(r.date)}`,
      `DTEND;VALUE=DATE:${ymd(addDay(r.date))}`,
      `SUMMARY:${escapeText(`🏁 ${r.name}`)}`,
      `DESCRIPTION:${escapeText([bits.join(", "), `${base}/plan`].filter(Boolean).join("\n"))}`,
      "CATEGORIES:Running,Race",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Links that subscribe a calendar app to the feed. */
export function subscribeLinks(feedUrl: string) {
  const webcal = feedUrl.replace(/^https?:\/\//, "webcal://");
  return {
    https: feedUrl,
    webcal,
    // Google Calendar's "add by URL" deep link; it accepts webcal:// in cid
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
  };
}
