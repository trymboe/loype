import { headers } from "next/headers";
import { CalendarDays } from "lucide-react";
import { Card, CardHeader, IconTile, PageHeader } from "@/components/ui";
import { subscribeLinks } from "@/lib/calendar/ical";
import { getFeed } from "@/lib/calendar/service";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { relativeTime } from "@/lib/dates";
import { disableFeedAction, rotateFeedAction } from "./actions";
import { CopyField, TimeForm } from "./feed-controls";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default async function CalendarPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const feed = await getFeed(createAdminClient(), user.id);
  const links = feed ? subscribeLinks(`${await origin()}/api/calendar/${feed.token}.ics`) : null;

  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Calendar" subtitle="See planned workouts next to the rest of your week" />
      {!feed || !links ? (
        <Card>
          <div className="flex items-start gap-3.5">
            <IconTile color="var(--accent)">
              <CalendarDays size={18} />
            </IconTile>
            <div className="min-w-0 flex-1">
              <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Subscribe to your plan</p>
              <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
                Løype makes a private calendar link with every planned workout and your race day. Google Calendar, Apple Calendar and Outlook keep it up to date
                when the plan changes.
              </p>
            </div>
          </div>
          <form action={rotateFeedAction} className="mt-5">
            <button className="btn btn-primary btn-block min-h-12">Turn on calendar feed</button>
          </form>
        </Card>
      ) : (
        <div className="stagger space-y-3">
          <Card>
            <CardHeader title="Add to your calendar" aside={feed.lastFetchedAt ? `Last read ${relativeTime(feed.lastFetchedAt)}` : "Not read yet"} />
            <div className="mt-4 space-y-2">
              <a href={links.google} target="_blank" rel="noreferrer" className="btn btn-primary btn-block min-h-12">
                Add to Google Calendar
              </a>
              <a href={links.webcal} className="btn btn-secondary btn-block min-h-12">
                Open in Apple Calendar or Outlook
              </a>
            </div>
            <p className="mt-5 mb-2 text-sm font-semibold">Or copy the link</p>
            <CopyField value={links.https} />
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Google Calendar refreshes subscribed calendars on its own schedule, usually within a few hours up to a day, so a moved workout can take a while to
              appear there. Apple Calendar and Outlook follow the hourly refresh hint. Skipped workouts and rest days are left out; completed ones get a ✓.
            </p>
          </Card>

          <Card>
            <CardHeader title="Event times" />
            <p className="mt-1 mb-4 text-[0.8125rem] leading-snug text-muted">All-day events stay out of the way. A set time blocks the workout&apos;s length in your day.</p>
            <TimeForm startTime={feed.startTime} />
          </Card>

          <Card>
            <CardHeader title="Privacy" />
            <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
              Anyone with the link can see your planned workouts, nothing else. If it leaks, make a new link: the old one stops working at once and you add the
              new one to your calendar again.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <form action={rotateFeedAction}>
                <button className="btn btn-secondary btn-block">New link</button>
              </form>
              <form action={disableFeedAction}>
                <button className="btn btn-secondary btn-block text-danger">Turn off</button>
              </form>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
