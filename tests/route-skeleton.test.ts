import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { layoutFor } from "@/components/feedback/route-skeleton";

type HeaderProps = { title?: string; back?: { href: string; label: string } };
const header = (path: string) => (layoutFor(path).header as ReactElement<HeaderProps>).props;

describe("loading screen for a route", () => {
  it("names the tab being opened", () => {
    expect(header("/").title).toBe("Today");
    expect(header("/activities").title).toBe("Activities");
    expect(header("/plan").title).toBe("Plan");
    expect(header("/progress").title).toBe("Progress");
    expect(header("/routes").title).toBe("Routes");
    expect(header("/more").title).toBe("More");
    expect(header("/coach").title).toBe("Coach");
  });

  it("names sub-screens and links back to their section", () => {
    expect(header("/more/profile")).toMatchObject({ title: "Athlete profile", back: { href: "/more", label: "More" } });
    expect(header("/plan/goal")).toMatchObject({ title: "Goal", back: { href: "/plan" } });
    expect(header("/progress/weeks")).toMatchObject({ title: "Weekly recaps", back: { href: "/progress" } });
    expect(header("/progress/weeks/2026-11-02")).toMatchObject({ title: "Week in review", back: { href: "/progress/weeks" } });
    expect(header("/routes/new").title).toBe("Plan a route");
  });

  it("doesn't guess titles that come from data", () => {
    expect(header("/activities/abc")).toMatchObject({ back: { href: "/activities" } });
    expect(header("/activities/abc").title).toBeUndefined();
    expect(header("/plan/workouts/abc").title).toBeUndefined();
    expect(header("/routes/abc").title).toBeUndefined();
  });
});
