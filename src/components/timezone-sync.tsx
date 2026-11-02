"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setTimezone } from "@/app/(app)/tz-actions";
import { TZ_COOKIE } from "@/lib/tz";

/** Keeps the server's idea of "today" in the zone the user is actually in (e.g. while travelling). */
export function TimezoneSync() {
  const router = useRouter();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${TZ_COOKIE}=`))
      ?.slice(TZ_COOKIE.length + 1);
    if (current && decodeURIComponent(current) === tz) return;
    void setTimezone(tz).then((ok) => ok && router.refresh());
  }, [router]);
  return null;
}
