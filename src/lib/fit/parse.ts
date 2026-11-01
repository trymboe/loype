import { Decoder, Stream } from "@garmin/fitsdk";
import { semicirclesToDegrees } from "../analytics/geo";
import type { ActivityStreams, Maybe, NormalizedActivity, NormalizedLap, TimerEvent } from "./types";

export class FitParseError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mesg = Record<string, any>;

const num = (v: unknown): Maybe => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Sports where FIT "cadence" is strides/min and must be doubled to steps/min. */
const STRIDE_CADENCE_SPORTS = new Set(["running", "walking", "hiking", "training"]);

function toSpm(sport: string, cadence: Maybe, fractional: Maybe): Maybe {
  if (cadence == null) return null;
  const c = cadence + (fractional ?? 0);
  return STRIDE_CADENCE_SPORTS.has(sport) ? c * 2 : c;
}

/**
 * Decode a FIT activity file into a NormalizedActivity.
 * Throws FitParseError if the bytes are not a decodable FIT activity.
 */
export function parseFitActivity(bytes: Uint8Array): NormalizedActivity {
  const stream = Stream.fromArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  if (!Decoder.isFIT(stream)) throw new FitParseError("Not a FIT file");
  const decoder = new Decoder(stream);
  const integrityOk = decoder.checkIntegrity();
  const { messages: rawMessages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    includeUnknownData: false,
    mergeHeartRates: true,
  });

  const messages = rawMessages as unknown as Record<string, Mesg[] | undefined>;
  const warnings: string[] = [];
  if (!integrityOk) warnings.push("FIT integrity check failed (CRC or size); data may be truncated");
  for (const e of errors ?? []) warnings.push(`decoder: ${String((e as Error)?.message ?? e)}`);

  const sessions: Mesg[] = messages.sessionMesgs ?? [];
  const records: Mesg[] = messages.recordMesgs ?? [];
  if (sessions.length === 0 && records.length === 0) {
    throw new FitParseError("FIT file contains no session or record messages");
  }
  if (sessions.length > 1) warnings.push(`FIT file has ${sessions.length} sessions; using the first`);
  const session: Mesg = sessions[0] ?? {};

  const sport = str(session.sport) ?? str(messages.sportMesgs?.[0]?.sport) ?? "unknown";
  const subSport = str(session.subSport) ?? str(messages.sportMesgs?.[0]?.subSport);

  const firstRecordTime: Date | undefined = records.find((r) => r.timestamp instanceof Date)?.timestamp;
  const startTime: Date | undefined =
    session.startTime instanceof Date ? session.startTime : firstRecordTime;
  if (!startTime) throw new FitParseError("FIT file has no start time");
  const t0 = startTime.getTime();
  const offsetOf = (d: unknown): number | null =>
    d instanceof Date ? (d.getTime() - t0) / 1000 : null;

  // UTC offset from the activity message (localTimestamp is seconds since FIT epoch, local time).
  let utcOffsetS: Maybe = null;
  const activity: Mesg | undefined = messages.activityMesgs?.[0];
  if (activity && activity.timestamp instanceof Date && typeof activity.localTimestamp === "number") {
    const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);
    const localMs = FIT_EPOCH_MS + activity.localTimestamp * 1000;
    const diff = Math.round((localMs - activity.timestamp.getTime()) / 1000);
    utcOffsetS = Math.round(diff / 900) * 900; // offsets are multiples of 15 min
  }

  const fileId: Mesg = messages.fileIdMesgs?.[0] ?? {};
  const device = {
    manufacturer: str(fileId.manufacturer),
    product: str(fileId.garminProduct ?? fileId.productName ?? fileId.product),
    serial: num(fileId.serialNumber),
  };

  // --- streams ---
  const streams: ActivityStreams = {
    t: [],
    distance: [],
    speed: [],
    hr: [],
    cadence: [],
    altitude: [],
    lat: [],
    lng: [],
  };
  let lastT = -Infinity;
  for (const r of records) {
    const t = offsetOf(r.timestamp);
    if (t == null) continue;
    if (t < lastT) {
      warnings.push("record timestamps out of order; skipped sample");
      continue;
    }
    if (t === lastT && streams.t.length > 0) {
      // Duplicate timestamp: merge non-null values into the previous sample.
      const i = streams.t.length - 1;
      mergeInto(streams, i, sport, r);
      continue;
    }
    lastT = t;
    streams.t.push(t);
    pushRecord(streams, sport, r);
  }

  // --- timer events ---
  const timerEvents: TimerEvent[] = [];
  for (const e of (messages.eventMesgs ?? []) as Mesg[]) {
    if (e.event !== "timer") continue;
    const t = offsetOf(e.timestamp);
    if (t == null) continue;
    const et = String(e.eventType);
    if (et === "start") timerEvents.push({ t, type: "start" });
    else if (et.startsWith("stop")) timerEvents.push({ t, type: "stop" });
  }
  timerEvents.sort((a, b) => a.t - b.t);

  // --- laps ---
  const laps: NormalizedLap[] = ((messages.lapMesgs ?? []) as Mesg[]).map((l, index) => ({
    index,
    startOffsetS: offsetOf(l.startTime) ?? 0,
    elapsedS: num(l.totalElapsedTime),
    timerS: num(l.totalTimerTime),
    distanceM: num(l.totalDistance),
    avgSpeed: num(l.enhancedAvgSpeed ?? l.avgSpeed),
    maxSpeed: num(l.enhancedMaxSpeed ?? l.maxSpeed),
    avgHr: num(l.avgHeartRate),
    maxHr: num(l.maxHeartRate),
    avgCadence: toSpm(sport, num(l.avgRunningCadence ?? l.avgCadence), num(l.avgFractionalCadence)),
    totalAscentM: num(l.totalAscent),
    intensity: str(l.intensity),
    trigger: str(l.lapTrigger),
    workoutStepIndex: num(l.wktStepIndex),
  }));

  return {
    sport,
    subSport,
    startTime,
    utcOffsetS,
    device,
    totals: {
      distanceM: num(session.totalDistance),
      elapsedS: num(session.totalElapsedTime),
      timerS: num(session.totalTimerTime),
      avgHr: num(session.avgHeartRate),
      maxHr: num(session.maxHeartRate),
      avgCadence: toSpm(
        sport,
        num(session.avgRunningCadence ?? session.avgCadence),
        num(session.avgFractionalCadence),
      ),
      totalAscentM: num(session.totalAscent),
      totalDescentM: num(session.totalDescent),
      calories: num(session.totalCalories),
      avgSpeed: num(session.enhancedAvgSpeed ?? session.avgSpeed),
      maxSpeed: num(session.enhancedMaxSpeed ?? session.maxSpeed),
    },
    laps,
    streams,
    timerEvents,
    warnings,
  };
}

function coords(r: Mesg): [Maybe, Maybe] {
  const lat = semicirclesToDegrees(num(r.positionLat));
  const lng = semicirclesToDegrees(num(r.positionLong));
  if (lat == null || lng == null) return [null, null];
  if (lat === 0 && lng === 0) return [null, null]; // "null island" = no fix
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return [null, null];
  return [lat, lng];
}

function pushRecord(s: ActivityStreams, sport: string, r: Mesg) {
  const [lat, lng] = coords(r);
  s.distance.push(num(r.distance));
  s.speed.push(num(r.enhancedSpeed ?? r.speed));
  const hr = num(r.heartRate);
  s.hr.push(hr != null && hr > 0 ? hr : null);
  s.cadence.push(toSpm(sport, num(r.cadence), num(r.fractionalCadence)));
  s.altitude.push(num(r.enhancedAltitude ?? r.altitude));
  s.lat.push(lat);
  s.lng.push(lng);
}

function mergeInto(s: ActivityStreams, i: number, sport: string, r: Mesg) {
  const tmp: ActivityStreams = { t: [], distance: [], speed: [], hr: [], cadence: [], altitude: [], lat: [], lng: [] };
  pushRecord(tmp, sport, r);
  for (const k of ["distance", "speed", "hr", "cadence", "altitude", "lat", "lng"] as const) {
    if (s[k][i] == null && tmp[k][0] != null) s[k][i] = tmp[k][0];
  }
}
