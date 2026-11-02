import { describe, expect, it } from "vitest";
import { buildCalendar, describeSteps, escapeText, foldLine, subscribeLinks, type FeedWorkout } from "@/lib/calendar/ical";
import type { Step } from "@/lib/planning/types";

const t = (label: string) => ({ zone: "easy" as const, paceFast: null, paceSlow: null, hrMin: null, hrMax: null, label });
const steps: Step[] = [
  { kind: "warmup", durationS: 600, target: t("Easy 6:10–6:40/km") },
  { kind: "repeat", count: 5, steps: [{ kind: "run", durationS: 300, target: t("Threshold 4:55–5:02/km") }, { kind: "recover", durationS: 90, target: t("Jog"), note: "easy jog" }] },
  { kind: "cooldown", distanceM: 2000, target: t("Easy") },
];

const w = (over: Partial<FeedWorkout> = {}): FeedWorkout => ({
  id: "11111111-1111-1111-1111-111111111111",
  date: "2026-11-04",
  type: "threshold",
  title: "Threshold intervals",
  objective: "Raise the pace you can hold for an hour, without racing it.",
  why: "Your threshold pace is the main limiter for 10 km.",
  steps,
  durationS: 3150,
  distanceM: 8400,
  key: true,
  status: "planned",
  updatedAt: "2026-11-02T10:00:00Z",
  ...over,
});

const opts = { appUrl: "https://loype.vercel.app/", startTime: null, timezone: null, now: new Date("2026-11-02T12:00:00Z") };

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("iCalendar feed", () => {
  it("escapes text values", () => {
    expect(escapeText("a, b; c\\d\nnext")).toBe("a\\, b\\; c\\\\d\\nnext");
  });

  it("folds long lines at 75 octets without splitting characters", () => {
    const line = `SUMMARY:${"ø".repeat(60)}`;
    const folded = foldLine(line);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  it("outlines steps including repeats", () => {
    expect(describeSteps(steps)).toEqual([
      "Warm-up 10 min: Easy 6:10–6:40/km",
      "5× repeat:",
      "  Run 5 min: Threshold 4:55–5:02/km",
      "  Recover 90 s: Jog (easy jog)",
      "Cool-down 2.0 km: Easy",
    ]);
  });

  it("produces all-day events with CRLF line endings, stable UIDs and a link back", () => {
    const ics = buildCalendar([w()], [], opts);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const u = unfold(ics);
    expect(u).toContain("UID:workout-11111111-1111-1111-1111-111111111111@loype");
    expect(u).toContain("DTSTART;VALUE=DATE:20261104");
    expect(u).toContain("DTEND;VALUE=DATE:20261105");
    expect(u).toContain("SUMMARY:Threshold intervals · 53 min");
    expect(u).toContain("URL:https://loype.vercel.app/plan/workouts/11111111-1111-1111-1111-111111111111");
    expect(u).toContain("DTSTAMP:20261102T120000Z");
    expect(u).toContain("CATEGORIES:Running\\,Key session");
  });

  it("uses timed events in the athlete's zone when a start time is set", () => {
    const u = unfold(buildCalendar([w()], [], { ...opts, startTime: "07:30", timezone: "Europe/Oslo" }));
    expect(u).toContain("DTSTART;TZID=Europe/Oslo:20261104T073000");
    expect(u).toContain("DURATION:PT53M");
    expect(u).toContain("X-WR-TIMEZONE:Europe/Oslo");
    expect(u).not.toContain("VALUE=DATE:20261104");
  });

  it("leaves out skipped workouts and rest days, marks completed and missed ones", () => {
    const u = unfold(
      buildCalendar(
        [
          w({ id: "a", status: "skipped" }),
          w({ id: "b", type: "rest", title: "Rest", steps: [], durationS: 0 }),
          w({ id: "c", status: "completed", title: "Easy run", durationS: 2400 }),
          w({ id: "d", status: "missed", title: "Long run", durationS: 4500 }),
        ],
        [],
        opts,
      ),
    );
    expect(u).not.toContain("UID:workout-a@");
    expect(u).not.toContain("UID:workout-b@");
    expect(u).toContain("SUMMARY:✓ Easy run · 40 min");
    expect(u).toContain("SUMMARY:Missed: Long run · 1 h 15 min");
  });

  it("adds the race day unless the plan already has it as a workout", () => {
    const race = { id: "g", name: "Oslo 10K", date: "2026-12-06", distanceM: 10_000, targetTimeS: 2880 };
    const u = unfold(buildCalendar([w()], [race], opts));
    expect(u).toContain("UID:race-g@loype");
    expect(u).toContain("SUMMARY:🏁 Oslo 10K");
    expect(u).toContain("10 km\\, target 48:00");
    const dup = unfold(buildCalendar([w({ id: "r", date: "2026-12-06", type: "race", title: "Race" })], [race], opts));
    expect(dup).not.toContain("UID:race-g@loype");
  });

  it("builds Google, webcal and https subscribe links", () => {
    const l = subscribeLinks("https://loype.vercel.app/api/calendar/abc.ics");
    expect(l.webcal).toBe("webcal://loype.vercel.app/api/calendar/abc.ics");
    expect(l.google).toBe("https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Floype.vercel.app%2Fapi%2Fcalendar%2Fabc.ics");
  });
});
