"use client";

import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { holdNavProgress } from "./nav-progress";
import { BackLink, PageHeader } from "@/components/ui";

/**
 * Loading screen for every in-app route (each section's loading.tsx renders
 * this). It shows the real title and back link of the screen being opened, so
 * a tap is answered at once with the right place, and a placeholder in the
 * rough shape of what's coming while the server fetches the data.
 */
export default function RouteSkeleton() {
  const path = usePathname();
  // the top bar keeps running until the real screen replaces this one
  useEffect(() => holdNavProgress(), []);
  const { header, body } = layoutFor(path);
  return (
    <div aria-busy="true" aria-label="Loading">
      {header}
      {body}
    </div>
  );
}

type Layout = { header: ReactNode; body: ReactNode };

const MORE_TITLES: Record<string, string> = {
  profile: "Athlete profile",
  calendar: "Calendar",
  password: "Change password",
  integrations: "Integrations",
  shoes: "Shoes",
  data: "Your data",
};

const PLAN_TITLES: Record<string, string> = {
  goal: "Goal",
  history: "Plan history",
  new: "New plan",
  race: "Race",
};

export function layoutFor(path: string): Layout {
  const [section, sub, leaf] = path.split("/").filter(Boolean);
  const titled = (title: string, body: ReactNode, back?: { href: string; label: string }) => ({ header: <PageHeader title={title} back={back} />, body });
  const untitled = (back: { href: string; label: string }, body: ReactNode) => ({ header: <SkeletonHeader back={back} />, body });

  switch (section) {
    case undefined:
      return titled("Today", <TodayBody />);
    case "activities":
      return sub ? untitled({ href: "/activities", label: "Activities" }, <DetailBody />) : titled("Activities", <ListBody rows={7} thumb />);
    case "routes":
      if (!sub) return titled("Routes", <ListBody rows={5} thumb />);
      if (sub === "new") return titled("Plan a route", <MapBody tall />, { href: "/routes", label: "Routes" });
      if (leaf === "edit") return titled("Edit route", <MapBody tall />, { href: `/routes/${sub}`, label: "Route" });
      return untitled({ href: "/routes", label: "Routes" }, <DetailBody />);
    case "plan":
      if (!sub) return titled("Plan", <PlanBody />);
      if (sub === "workouts") return untitled({ href: "/plan", label: "Plan" }, <WorkoutBody />);
      return titled(PLAN_TITLES[sub] ?? "Plan", <FormBody />, { href: "/plan", label: "Plan" });
    case "progress":
      if (!sub) return titled("Progress", <ChartsBody />);
      if (!leaf) return titled("Weekly recaps", <ListBody rows={6} />, { href: "/progress", label: "Progress" });
      return titled("Week in review", <ChartsBody />, { href: "/progress/weeks", label: "Weekly recaps" });
    case "more":
      return sub ? titled(MORE_TITLES[sub] ?? "More", <FormBody />, { href: "/more", label: "More" }) : titled("More", <ListBody rows={7} icon />);
    case "coach":
      return titled("Coach", <ChatBody />);
    default:
      return { header: <SkeletonHeader />, body: <TodayBody /> };
  }
}

function SkeletonHeader({ back }: { back?: { href: string; label: string } }) {
  return (
    <header className="mb-6">
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="skeleton mb-2.5 h-3.5 w-36" />
      <div className="skeleton h-8 w-52 rounded-lg" />
    </header>
  );
}

function Lines({ widths }: { widths: string[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <div key={i} className={`skeleton h-3 ${w} ${i ? "mt-2.5" : ""}`} />
      ))}
    </>
  );
}

function StatsCard() {
  return (
    <div className="card p-5">
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <div className="skeleton h-3 w-14" />
            <div className="skeleton mt-2 h-7 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TodayBody() {
  return (
    <div className="space-y-3">
      <div className="card h-44 p-5">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton mt-3 h-6 w-40" />
        <div className="mt-8 grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-8" />
          ))}
        </div>
      </div>
      <div className="card h-56" />
      <div className="card h-32" />
    </div>
  );
}

function ListBody({ rows, thumb, icon }: { rows: number; thumb?: boolean; icon?: boolean }) {
  return (
    <div className="card divide-hairline overflow-hidden">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3.5 px-4 py-3.5">
          {thumb && <div className="skeleton size-[52px] shrink-0 rounded-xl" />}
          {icon && <div className="skeleton size-9 shrink-0 rounded-[0.625rem]" />}
          <div className="min-w-0 flex-1">
            <div className="skeleton h-3.5 w-2/5" />
            {!icon && <div className="skeleton mt-2 h-3 w-3/5" />}
          </div>
        </div>
      ))}
    </div>
  );
}

function MapBody({ tall }: { tall?: boolean }) {
  return <div className={`skeleton w-full rounded-[1.375rem] ${tall ? "h-[60vh]" : "h-56"}`} />;
}

function DetailBody() {
  return (
    <div className="space-y-3">
      <MapBody />
      <StatsCard />
      <div className="card h-48" />
    </div>
  );
}

function WorkoutBody() {
  return (
    <div className="space-y-3">
      <StatsCard />
      <div className="card p-5">
        <Lines widths={["w-24", "w-full", "w-5/6", "w-4/6"]} />
      </div>
      <div className="card h-28" />
    </div>
  );
}

function PlanBody() {
  return (
    <div className="space-y-3">
      <div className="card p-5">
        <Lines widths={["w-28", "w-48"]} />
        <div className="mt-5 grid grid-cols-7 gap-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="skeleton h-14" />
          ))}
        </div>
      </div>
      <ListBody rows={4} />
    </div>
  );
}

function ChartsBody() {
  return (
    <div className="space-y-3">
      <StatsCard />
      <div className="card p-5">
        <div className="skeleton h-3 w-28" />
        <div className="skeleton mt-4 h-40 w-full" />
      </div>
      <div className="card h-40" />
    </div>
  );
}

function FormBody() {
  return (
    <div className="card space-y-5 p-5">
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="skeleton h-3 w-28" />
          <div className="skeleton mt-2 h-12 w-full rounded-[0.875rem]" />
        </div>
      ))}
    </div>
  );
}

function ChatBody() {
  return (
    <div className="space-y-3">
      <div className="skeleton ml-auto h-10 w-3/5 rounded-2xl" />
      <div className="card p-4">
        <Lines widths={["w-full", "w-11/12", "w-2/3"]} />
      </div>
      <div className="skeleton ml-auto h-10 w-2/5 rounded-2xl" />
    </div>
  );
}
