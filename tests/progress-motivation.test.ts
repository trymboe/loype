import { describe, expect, it } from "vitest";
import { addDaysIso } from "@/lib/dates";
import { backToPrevious, computeMilestones, type MilestoneRun } from "@/lib/progress/milestones";
import { payingOff } from "@/lib/progress/paying-off";
import { pickInsight, type InsightInput } from "@/lib/progress/insight";

const TODAY = "2026-11-02"; // a Monday
let n = 0;
const run = (date: string, km: number, best: Record<number, number> = {}): MilestoneRun => ({
  id: `r${n++}`,
  date,
  distanceM: km * 1000,
  movingS: km * 330,
  bestEfforts: Object.entries(best).map(([d, t]) => ({ distanceM: Number(d), timeS: t })),
});
/** `perWeek` runs a week for `weeks` weeks ending at `end` */
const block = (end: string, weeks: number, perWeek: number, km: number) =>
  Array.from({ length: weeks * perWeek }, (_, i) => run(addDaysIso(end, -Math.floor(i / perWeek) * 7 - (i % perWeek) * 2), km));

describe("milestones", () => {
  it("finds longest run, firsts, best efforts with improvement, biggest week, consistent month and totals", () => {
    const runs = [
      run("2026-06-01", 6, { 5000: 1700 }),
      run("2026-06-03", 8),
      run("2026-07-10", 12, { 5000: 1660, 10_000: 3500 }),
      run("2026-10-30", 15.2, { 5000: 1620 }),
      ...block("2026-09-28", 4, 3, 7),
    ];
    const ms = computeMilestones(runs, [], TODAY);
    const by = Object.fromEntries(ms.map((m) => [m.key, m]));
    expect(by.longest_run.value).toBe("15.2 km");
    expect(by.longest_run.isNew).toBe(true);
    expect(by.first_15000.date).toBe("2026-10-30");
    expect(by.best_5000.value).toBe("27:00");
    expect(by.best_5000.detail).toMatch(/0:40 faster/);
    expect(by.best_10000.value).toBe("58:20");
    expect(by.biggest_week.value).toBe("21.0 km");
    expect(by.consistent_month.detail).toMatch(/September 2026/);
    expect(by.total_100.value).toMatch(/km/);
    expect(by.week_streak.value).toBe("5 weeks"); // runs every other day spill into the week before
    // newest first
    expect(ms[0].date >= ms[ms.length - 1].date).toBe(true);
  });

  it("recognises getting back to previous fitness only after a real dip", () => {
    const pts = [44, 45, 45.2, 43.4, 43, 44, 45.1].map((v, i) => ({ date: addDaysIso("2026-06-07", i * 7), value: v }));
    const back = backToPrevious(pts)!;
    expect(back.value).toBe(45.1);
    expect(back.low).toBe(43);
    expect(back.before).toBe(45.2);
    expect(backToPrevious([45, 44.5, 45].map((v, i) => ({ date: addDaysIso("2026-06-07", i * 7), value: v })))).toBeNull();
  });

  it("returns nothing without runs", () => {
    expect(computeMilestones([], [], TODAY)).toEqual([]);
  });
});

describe("your training is paying off", () => {
  const ef = (from: string, to: string, v: number) => {
    const out = [];
    for (let d = from; d <= to; d = addDaysIso(d, 5)) out.push({ date: d, ef: v });
    return out;
  };

  it("reports gains and links them to the training behind them", () => {
    const runs = [...block("2026-11-01", 8, 3, 8), ...block("2026-09-06", 8, 2, 6)];
    const p = payingOff({
      runs,
      vdot: [
        { date: "2026-09-06", value: 42 },
        { date: "2026-11-01", value: 43.5 },
      ],
      ef: [...ef("2026-08-10", "2026-09-06", 1.0), ...ef("2026-10-06", "2026-11-01", 1.05)],
      today: TODAY,
    });
    expect(p.state).toBe("paying_off");
    const keys = Object.fromEntries(p.items.map((i) => [i.key, i]));
    expect(keys.vdot.tone).toBe("good");
    expect(keys.efficiency.tone).toBe("good");
    expect(keys.efficiency.title).toMatch(/5 % more speed/);
    expect(keys.volume.tone).toBe("good");
    expect(p.summary).toMatch(/has come with/);
  });

  it("is honest about a dip and explains it by less running", () => {
    const runs = [...block("2026-11-01", 3, 1, 5), ...block("2026-09-06", 8, 3, 8)];
    const p = payingOff({
      runs,
      vdot: [
        { date: "2026-09-06", value: 45 },
        { date: "2026-11-01", value: 43.8 },
      ],
      ef: [],
      today: TODAY,
    });
    expect(p.state).toBe("not_enough_data");
    const more = [...block("2026-11-01", 4, 1, 5), ...block("2026-09-06", 8, 3, 8)];
    const q = payingOff({ runs: more, vdot: [{ date: "2026-09-06", value: 45 }, { date: "2026-11-01", value: 43.8 }], ef: [], today: TODAY });
    expect(q.state).toBe("dipped");
    expect(q.summary).toMatch(/Less running/);
    expect(q.items.find((i) => i.key === "vdot")!.tone).toBe("down");
  });

  it("calls small changes steady", () => {
    const runs = [...block("2026-11-01", 8, 3, 7), ...block("2026-09-06", 8, 3, 7)];
    const p = payingOff({ runs, vdot: [{ date: "2026-09-06", value: 45 }, { date: "2026-11-01", value: 45.2 }], ef: [], today: TODAY });
    expect(p.items.find((i) => i.key === "vdot")!.tone).toBe("steady");
    expect(p.items.find((i) => i.key === "volume")!.tone).toBe("steady");
  });

  it("spots new best efforts in the block", () => {
    const runs = [...block("2026-11-01", 8, 2, 6), run("2026-10-20", 5, { 5000: 1500 }), run("2026-07-01", 5, { 5000: 1560 })];
    const p = payingOff({ runs, vdot: [], ef: [], today: TODAY });
    const b = p.items.find((i) => i.key === "best_effort")!;
    expect(b.detail).toMatch(/5 km 25:00 \(−1:00\)/);
  });
});

describe("latest insight", () => {
  const base: InsightInput = { today: TODAY, pendingProposal: null, milestones: [], payoff: null, load: null, rampRate: null, race: null };
  it("prioritises a pending plan change, then race week, then fatigue, then milestones", () => {
    const milestone = { key: "longest_run", kind: "distance" as const, title: "Longest run", value: "15 km", detail: "", date: "2026-11-01", activityId: "a", isNew: true };
    expect(pickInsight({ ...base, pendingProposal: { title: "Ease this week" }, milestones: [milestone] })!.key).toBe("proposal");
    expect(pickInsight({ ...base, race: { name: "Oslo 10k", daysToGo: 5 }, milestones: [milestone] })!.key).toBe("race_close");
    expect(pickInsight({ ...base, load: { ctl: 40, tsb: -25 }, milestones: [milestone] })!.key).toBe("fatigue");
    expect(pickInsight({ ...base, milestones: [milestone] })!.href).toBe("/activities/a");
    expect(pickInsight({ ...base, load: { ctl: 40, tsb: -5 }, rampRate: 10 })!.key).toBe("ramp");
    expect(pickInsight(base)).toBeNull();
  });
});
