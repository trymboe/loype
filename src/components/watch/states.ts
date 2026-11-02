import type { Tone } from "@/components/ui";

/** Labels for outbound sync states. Wording never claims more than we know. */
export const WATCH_STATE: Record<string, { label: string; tone: Tone; detail: string }> = {
  pending: { label: "Queued", tone: "muted", detail: "Waiting to be sent to Intervals.icu." },
  sent: { label: "Sent to Intervals.icu", tone: "accent", detail: "Intervals.icu accepted it, but its reading of the steps couldn't be checked." },
  parsed: {
    label: "On Intervals.icu",
    tone: "accent",
    detail: "Intervals.icu read every step and target correctly. Garmin Connect picks it up from there; check your watch's workout list to confirm.",
  },
  mismatch: { label: "Check on Intervals.icu", tone: "warn", detail: "Intervals.icu stored the workout but read it differently from the plan." },
  on_watch: { label: "On your watch", tone: "good", detail: "You confirmed this version is on the watch." },
  failed: { label: "Not sent", tone: "hr", detail: "The last attempt failed. Løype retries on the next sync." },
  removed: { label: "Removed", tone: "muted", detail: "Removed from Intervals.icu because the workout changed to rest, was skipped or left the plan." },
};
