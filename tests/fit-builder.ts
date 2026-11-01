/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Builds realistic synthetic FIT activity files with Garmin's encoder, so the
 * parser is tested against real binary FIT data rather than mocked objects.
 * Used only in tests and the clearly labelled demo seed.
 */
import { Encoder, Profile } from "@garmin/fitsdk";

export interface SyntheticSegment {
  durationS: number;
  speedMs: number; // 0 = standing still with timer running
  hr: number;
  cadenceSpm?: number;
  paused?: boolean; // timer stopped for this segment (no records written)
  climbMPerS?: number;
}

export interface SyntheticOptions {
  start?: Date;
  segments: SyntheticSegment[];
  subSport?: string;
  gps?: boolean;
  /** indices (sample numbers) at which to inject a GPS jump of ~500 m */
  gpsSpikesAt?: number[];
  hrMissing?: boolean;
  hrFollowsCadence?: boolean;
  recordIntervalS?: number;
  lapEveryM?: number;
}

const onMesg = (enc: Encoder, num: number, m: Record<string, unknown>) => enc.onMesg(num as any, m as any);
const DEG_TO_SEMI = 2 ** 31 / 180;

export function buildFit(opts: SyntheticOptions): Uint8Array {
  const start = opts.start ?? new Date("2026-10-01T06:00:00Z");
  const step = opts.recordIntervalS ?? 1;
  const gps = opts.gps ?? true;
  const enc = new Encoder();
  onMesg(enc, Profile.MesgNum.FILE_ID, {
    manufacturer: "development",
    product: 1,
    timeCreated: start,
    type: "activity",
  });
  onMesg(enc, Profile.MesgNum.EVENT, { timestamp: start, event: "timer", eventType: "start" });

  let t = 0; // elapsed seconds
  let dist = 0;
  let alt = 100;
  let lat = 59.9139; // Oslo
  const lng0 = 10.7522;
  let sample = 0;
  let timerS = 0;
  let maxHr = 0;
  let hrSum = 0;
  let hrN = 0;
  const laps: { start: number; startDist: number }[] = [{ start: 0, startDist: 0 }];
  const lapEvery = opts.lapEveryM ?? 1000;

  const ts = (sec: number) => new Date(start.getTime() + sec * 1000);

  const writeLap = (endT: number) => {
    const l = laps[laps.length - 1];
    onMesg(enc, Profile.MesgNum.LAP, {
      timestamp: ts(endT),
      startTime: ts(l.start),
      totalElapsedTime: endT - l.start,
      totalTimerTime: endT - l.start,
      totalDistance: dist - l.startDist,
      event: "lap",
      eventType: "stop",
      lapTrigger: "distance",
      sport: "running",
    });
  };

  for (const seg of opts.segments) {
    if (seg.paused) {
      onMesg(enc, Profile.MesgNum.EVENT, { timestamp: ts(t), event: "timer", eventType: "stopAll" });
      t += seg.durationS;
      onMesg(enc, Profile.MesgNum.EVENT, { timestamp: ts(t), event: "timer", eventType: "start" });
      continue;
    }
    for (let k = 0; k < seg.durationS; k += step) {
      t += step;
      timerS += step;
      dist += seg.speedMs * step;
      alt += (seg.climbMPerS ?? 0) * step;
      lat += (seg.speedMs * step) / 111_320; // move north
      sample++;
      const cadence = seg.cadenceSpm ?? (seg.speedMs > 0 ? 170 : 0);
      const hr = opts.hrFollowsCadence ? cadence : seg.hr;
      const spike = opts.gpsSpikesAt?.includes(sample);
      const rec: Record<string, unknown> = {
        timestamp: ts(t),
        distance: dist,
        enhancedSpeed: seg.speedMs,
        enhancedAltitude: alt,
        cadence: Math.floor(cadence / 2),
      };
      if (!opts.hrMissing) {
        rec.heartRate = hr;
        maxHr = Math.max(maxHr, hr);
        hrSum += hr;
        hrN++;
      }
      if (gps) {
        rec.positionLat = Math.round((spike ? lat + 0.005 : lat) * DEG_TO_SEMI);
        rec.positionLong = Math.round(lng0 * DEG_TO_SEMI);
      }
      onMesg(enc, Profile.MesgNum.RECORD, rec);
      if (dist - laps[laps.length - 1].startDist >= lapEvery) {
        writeLap(t);
        laps.push({ start: t, startDist: dist });
      }
    }
  }
  onMesg(enc, Profile.MesgNum.EVENT, { timestamp: ts(t), event: "timer", eventType: "stopAll" });
  if (dist > laps[laps.length - 1].startDist) writeLap(t);

  onMesg(enc, Profile.MesgNum.SESSION, {
    timestamp: ts(t),
    startTime: start,
    sport: "running",
    subSport: opts.subSport ?? "generic",
    totalElapsedTime: t,
    totalTimerTime: timerS,
    totalDistance: dist,
    avgHeartRate: hrN ? Math.round(hrSum / hrN) : undefined,
    maxHeartRate: hrN ? maxHr : undefined,
    event: "session",
    eventType: "stop",
    firstLapIndex: 0,
    numLaps: laps.length,
  });
  onMesg(enc, Profile.MesgNum.ACTIVITY, {
    timestamp: ts(t),
    localTimestamp: Math.round((start.getTime() + t * 1000 + 3600_000 - 631065600000) / 1000),
    numSessions: 1,
    type: "manual",
    event: "activity",
    eventType: "stop",
    totalTimerTime: timerS,
  });
  return enc.close();
}
