import { headers } from "next/headers";
import { CalendarDays } from "lucide-react";
import { Card, CardHeader, IconTile, PageHeader } from "@/components/ui";
import { subscribeLinks } from "@/lib/calendar/ical";
import { getFeed } from "@/lib/calendar/service";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { relativeTime } from "@/lib/dates";
import { disableFeedAction, rotateFeedAction } from "./actions";
import { CopyField, TimeForm } from "./feed-controls";
import { SubmitButton } from "@/components/feedback/submit-button";

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
      <PageHeader back={{ href: "/more", label: "More" }} title="Calendar" />
      {!feed || !links ? (
        <Card>
          <div className="flex items-center gap-3.5">
            <IconTile color="var(--accent)">
              <CalendarDays size={18} />
            </IconTile>
            <p className="min-w-0 flex-1 text-[1.0625rem] font-semibold tracking-[-0.01em]">Show your plan in your calendar</p>
          </div>
          <form action={rotateFeedAction} className="mt-5">
            <SubmitButton className="btn btn-primary btn-block min-h-12">Turn on calendar feed</SubmitButton>
          </form>
        </Card>
      ) : (
        <div className="stagger space-y-3">
          <Card>
            <CardHeader title="Subscribe" />
            <div className="mt-4 space-y-2">
              <a href={links.webcal} className="btn btn-primary btn-block min-h-12">
                Apple Calendar
              </a>
              <a href={links.google} target="_blank" rel="noreferrer" className="btn btn-primary btn-block min-h-12">
                Google Calendar
              </a>
            </div>
            <p className="label mt-5 mb-2">Outlook and other apps</p>
            <CopyField value={links.https} />
          </Card>

          <Card>
            <CardHeader title="Event times" className="mb-4" />
            <TimeForm startTime={feed.startTime} />
          </Card>

          <Card>
            <CardHeader title="Calendar link" aside={feed.lastFetchedAt ? `Last read ${relativeTime(feed.lastFetchedAt)}` : "Not read yet"} />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <form action={rotateFeedAction}>
                <SubmitButton className="btn btn-secondary btn-block">New link</SubmitButton>
              </form>
              <form action={disableFeedAction}>
                <SubmitButton className="btn btn-secondary btn-block text-danger">Turn off</SubmitButton>
              </form>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
