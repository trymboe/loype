import Link from "next/link";
import type { ReactNode } from "react";
import { Activity, CalendarDays, Ellipsis, KeyRound, LineChart, Map as MapIcon, MessageCircle, RefreshCw, Send, Smartphone, Sun, Watch } from "lucide-react";
import { ButtonLink, Card, CardHeader, IconTile, PageHeader } from "@/components/ui";
import { getSessionUser, createAdminClient } from "@/lib/db/server";
import { loadOnboardingFacts } from "@/lib/onboarding/facts";
import { nextStep } from "@/lib/onboarding/state";
import { startSetupAction } from "./actions";

export const metadata = { title: "How Løype works" };
export const dynamic = "force-dynamic";

const A = ({ href, children }: { href: string; children: ReactNode }) =>
  href.startsWith("http") ? (
    <a className="font-medium text-accent underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <Link className="font-medium text-accent underline underline-offset-2" href={href}>
      {children}
    </Link>
  );

function Row({ icon, color, title, children }: { icon: ReactNode; color: string; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5 py-3 first:pt-0 last:pb-0">
      <IconTile color={color}>{icon}</IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] font-semibold">{title}</p>
        <div className="mt-0.5 text-[0.8125rem] leading-snug text-muted">{children}</div>
      </div>
    </li>
  );
}

export default async function GuidePage({ searchParams }: { searchParams: Promise<{ first?: string }> }) {
  const user = await getSessionUser();
  if (!user) return null;
  const first = (await searchParams).first === "1";
  const facts = await loadOnboardingFacts(createAdminClient(), user.id);
  const setupDone = nextStep(facts) === "done";

  return (
    <>
      <PageHeader
        eyebrow={first ? "Welcome" : "Guide"}
        title={first ? "Welcome to Løype" : "How Løype works"}
        subtitle="A running coach that plans your training from the runs you actually do, and adjusts as you go."
      />
      <div className="stagger space-y-3">
        <Card>
          <CardHeader title="The idea" className="mb-3" />
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted marker:font-semibold marker:text-fg-2">
            <li>You run with your watch as usual.</li>
            <li>Løype reads your runs from Garmin Connect or Strava. It never writes anything back to them.</li>
            <li>From your history it works out your current fitness and how much you can safely train.</li>
            <li>You pick a goal (a race, or just getting fitter) and it builds a plan around the days you can run.</li>
            <li>After each run it compares what you did with the plan and suggests changes when needed. You decide.</li>
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-muted">Your data is private to your account. Nobody else using Løype can see it.</p>
        </Card>

        <Card>
          <CardHeader title="Connect your runs" aside="pick one" className="mb-3" />
          <ul className="divide-hairline">
            <Row icon={<Watch size={18} />} color="var(--pace)" title="Garmin watch">
              Create a Personal API key in <A href="https://connect.garmin.com/app/settings/personalApiToken">Garmin Connect</A> (pick the longest expiry; it is only
              shown once) and paste it in setup. Imports runs plus sleep, resting heart rate and HRV.
            </Row>
            <Row icon={<Activity size={18} />} color="var(--hr)" title="Apple Watch or any other watch">
              Make sure your runs reach Strava (Apple Watch: Strava app → Settings → Applications, Services and Devices → Health). Then create your own free app at{" "}
              <A href="https://www.strava.com/settings/api">strava.com/settings/api</A> and paste its Client ID and Secret under{" "}
              <A href="/more/integrations#strava">Integrations → Strava</A>. The page shows exactly what to fill in.
            </Row>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            After connecting, import 3–6 months of history so Løype has a baseline. New runs then sync by themselves every 30 minutes; tap the sync button on Today to
            fetch right away.
          </p>
        </Card>

        <Card>
          <CardHeader title="Optional extras" className="mb-3" />
          <ul className="divide-hairline">
            <Row icon={<Send size={18} />} color="var(--accent)" title="Workouts on your Garmin watch">
              Connect <A href="/more/integrations">Intervals.icu</A> (free) with its API key, and Løype sends the next two weeks of planned workouts, with pace targets,
              through Intervals.icu to Garmin Connect and your watch.
            </Row>
            <Row icon={<CalendarDays size={18} />} color="var(--tempo)" title="Plan in your calendar">
              Subscribe to your plan in Google, Apple or Outlook under <A href="/more/calendar">More → Calendar</A>.
            </Row>
            <Row icon={<Smartphone size={18} />} color="var(--good)" title="Install it as an app">
              On iPhone: Share → Add to Home Screen. The home-screen app can&apos;t receive sign-in emails, so first set a password under{" "}
              <A href="/more/password">More → Password</A> and sign in with that.
            </Row>
          </ul>
        </Card>

        <Card>
          <CardHeader title="Finding your way" className="mb-3" />
          <ul className="divide-hairline">
            <Row icon={<Sun size={18} />} color="var(--accent)" title="Today">
              Today&apos;s workout, your latest run, this week so far and anything worth knowing.
            </Row>
            <Row icon={<CalendarDays size={18} />} color="var(--tempo)" title="Plan">
              Your weeks, each workout with its steps and why it&apos;s there, and suggested changes to accept or decline. Change your goal or running days from here.
            </Row>
            <Row icon={<LineChart size={18} />} color="var(--pace)" title="Progress">
              Fitness, training load and personal bests over time, with how each number is calculated.
            </Row>
            <Row icon={<Activity size={18} />} color="var(--hr)" title="Activities">
              Every run with map, splits, laps and charts. Add how it felt (effort and legs) after a run: it helps the plan adapt.
            </Row>
            <Row icon={<MapIcon size={18} />} color="var(--good)" title="Routes">
              Draw a route or generate a loop of a set distance, see surface and elevation, and send it to your phone or watch.
            </Row>
            <Row icon={<MessageCircle size={18} />} color="var(--cadence)" title="Coach">
              Ask questions about your training or ask for changes to the plan in plain language. It only sees your data, warns you about injury risk, and you approve
              every change.
            </Row>
            <Row icon={<Ellipsis size={18} />} color="var(--muted)" title="More">
              Integrations, heart-rate profile, password, calendar, data export and deletion, and this guide.
            </Row>
          </ul>
        </Card>

        <Card>
          <CardHeader title="Good to know" className="mb-3" />
          <ul className="space-y-2 text-sm leading-snug text-muted">
            <li className="flex gap-2.5">
              <RefreshCw size={16} className="mt-0.5 shrink-0 text-subtle" />
              The plan starts at what you already run and grows slowly. If it ever feels too much, tell the Coach or change the volume on the goal page.
            </li>
            <li className="flex gap-2.5">
              <KeyRound size={16} className="mt-0.5 shrink-0 text-subtle" />
              Your Garmin, Strava and Intervals.icu keys are stored encrypted and only used to read your own data. You can disconnect or delete everything under More.
            </li>
          </ul>
        </Card>

        {setupDone ? (
          <ButtonLink href="/">Go to Today</ButtonLink>
        ) : (
          <form action={startSetupAction}>
            <button className="btn btn-primary btn-block min-h-12">{first ? "Start setup" : "Continue setup"}</button>
          </form>
        )}
      </div>
    </>
  );
}
