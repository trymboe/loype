/**
 * The single most useful thing to tell the athlete on the Today screen.
 * Rule-based and calculated (not AI-written); candidates are ranked by
 * priority and the first one that applies wins.
 */
import { formatDay } from "../dates";
import type { Milestone } from "./milestones";
import type { Payoff } from "./paying-off";

export type InsightTone = "good" | "warn" | "info";

export interface Insight {
  key: string;
  tone: InsightTone;
  title: string;
  body: string;
  href: string;
  cta: string;
}

export interface InsightInput {
  today: string;
  pendingProposal: { title: string } | null;
  milestones: Milestone[];
  payoff: Payoff | null;
  /** latest training load: 42-day fitness and form */
  load: { ctl: number; tsb: number } | null;
  rampRate: number | null;
  race: { name: string; daysToGo: number } | null;
}

export function pickInsight(i: InsightInput): Insight | null {
  if (i.pendingProposal)
    return {
      key: "proposal",
      tone: "info",
      title: "Your coach suggests a change",
      body: `${i.pendingProposal.title}. Review it before it affects your next sessions.`,
      href: "/plan",
      cta: "Review",
    };

  if (i.race && i.race.daysToGo >= 0 && i.race.daysToGo <= 10)
    return {
      key: "race_close",
      tone: "info",
      title: i.race.daysToGo === 0 ? "Race day" : `${i.race.daysToGo} day${i.race.daysToGo === 1 ? "" : "s"} to ${i.race.name}`,
      body: "Fitness is already built. Keep runs short with a little pace, sleep well and check your pacing plan.",
      href: "/plan/race",
      cta: "Pacing plan",
    };

  // heavy fatigue relative to fitness (form well below zero), only meaningful with some base
  if (i.load && i.load.ctl >= 15 && i.load.tsb <= -Math.max(20, i.load.ctl * 0.4))
    return {
      key: "fatigue",
      tone: "warn",
      title: "Fatigue is high right now",
      body: `Your recent load is well above what you're used to (form ${Math.round(i.load.tsb)}). An easy day or two lets the work sink in.`,
      href: "/progress",
      cta: "See load",
    };
  if (i.rampRate != null && i.load && i.load.ctl >= 15 && i.rampRate > 8)
    return {
      key: "ramp",
      tone: "warn",
      title: "Load is rising fast",
      body: `Fitness load is climbing ${i.rampRate.toFixed(0)} points a week. Fast build-ups are when niggles start; hold this level for a week before adding more.`,
      href: "/progress",
      cta: "See load",
    };

  // a run-specific record beats a streak or total that ticks over every week
  const rank: Record<string, number> = { effort: 0, distance: 1, fitness: 2, volume: 3, consistency: 4, total: 5 };
  const fresh = i.milestones.filter((m) => m.isNew).sort((a, b) => rank[a.kind] - rank[b.kind] || b.date.localeCompare(a.date))[0];
  if (fresh)
    return {
      key: `milestone_${fresh.key}`,
      tone: "good",
      title: `${fresh.title}: ${fresh.value}`,
      body: `${fresh.detail ? `${capFirst(fresh.detail)}. ` : ""}Set on ${formatDay(fresh.date, { weekday: "long", day: "numeric", month: "short" })}.`,
      href: fresh.activityId ? `/activities/${fresh.activityId}` : "/progress",
      cta: fresh.activityId ? "See run" : "Progress",
    };

  const p = i.payoff;
  if (p && p.state === "paying_off") {
    const best = p.items.find((x) => x.tone === "good" && (x.key === "efficiency" || x.key === "vdot" || x.key === "best_effort")) ?? p.items.find((x) => x.tone === "good")!;
    return { key: `payoff_${best.key}`, tone: "good", title: best.title, body: best.detail, href: "/progress", cta: "Progress" };
  }
  if (p && p.state === "dipped") return { key: "dip", tone: "info", title: p.headline, body: p.summary, href: "/progress", cta: "Progress" };
  if (p && p.state === "steady") return { key: "steady", tone: "info", title: p.headline, body: p.summary, href: "/progress", cta: "Progress" };
  if (p && p.state === "not_enough_data") return { key: "sparse", tone: "info", title: p.headline, body: p.summary, href: "/progress", cta: "Progress" };
  return null;
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
