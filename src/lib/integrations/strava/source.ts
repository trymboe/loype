import type { ActivitySource } from "../../ingest/engine";
import type { DiscoveredItem } from "../../ingest/types";
import { StravaAuthError, StravaNotFoundError, StravaRateLimitError, type StravaClient } from "./client";
import { encodeBundle, decodeBundle, normalizeStrava, StravaParseError, STRAVA_RUN_TYPES, stravaType } from "./normalize";

export type StravaLike = Pick<StravaClient, "listActivities" | "getActivity" | "getStreams">;

const epoch = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);

/** Strava as an ingest source: list by date range, download = activity detail + streams as one JSON bundle. */
export function stravaSource(strava: StravaLike): ActivitySource {
  return {
    name: "strava",
    fileExt: "json",
    async listPage({ offset, limit, rangeStart, rangeEnd }) {
      const page = await strava.listActivities({
        // a day of slack either side: ranges are calendar dates, Strava filters on UTC instants
        after: rangeStart ? epoch(rangeStart) - 86400 : undefined,
        before: rangeEnd ? epoch(rangeEnd) + 2 * 86400 : undefined,
        page: Math.floor(offset / limit) + 1,
        perPage: limit,
      });
      const entries = Array.isArray(page) ? page : [];
      const items: DiscoveredItem[] = [];
      for (const a of entries) {
        if (a?.id == null) continue;
        const type = stravaType(a);
        const start = a.start_date ? new Date(a.start_date) : null;
        items.push({
          externalId: String(a.id),
          activityType: type,
          startTime: start && !Number.isNaN(start.getTime()) ? start : null,
          name: typeof a.name === "string" ? a.name : null,
          raw: a,
          // manual entries have no samples to analyse
          status: type && STRAVA_RUN_TYPES.has(type) && !a.manual ? "discovered" : "skipped_type",
        });
      }
      return { items, count: entries.length, reachedOlder: false };
    },
    async download(id) {
      const [activity, streams] = await Promise.all([strava.getActivity(id), strava.getStreams(id)]);
      return encodeBundle(activity, streams);
    },
    parse: (bytes) => normalizeStrava(decodeBundle(bytes)),
    classifyError(e) {
      if (e instanceof StravaAuthError) return "auth";
      if (e instanceof StravaRateLimitError) return "stop";
      if (e instanceof StravaNotFoundError) return "unavailable";
      if (e instanceof StravaParseError) return "permanent";
      return "retry";
    },
  };
}
