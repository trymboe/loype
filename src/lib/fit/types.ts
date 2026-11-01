/**
 * Normalized representation of a recorded activity, independent of the
 * source file format. All values are SI units; missing data is `null`
 * (never 0) so that "not recorded" and "zero" are never confused.
 */

export type Maybe = number | null;

export interface ActivityStreams {
  /** Seconds since activity start (elapsed, including pauses). */
  t: number[];
  distance: Maybe[]; // metres, cumulative
  speed: Maybe[]; // m/s
  hr: Maybe[]; // bpm
  cadence: Maybe[]; // steps per minute (both feet)
  altitude: Maybe[]; // metres
  lat: Maybe[]; // degrees
  lng: Maybe[]; // degrees
}

export interface TimerEvent {
  t: number; // seconds since start
  type: "start" | "stop";
}

export interface NormalizedLap {
  index: number;
  startOffsetS: number;
  elapsedS: Maybe;
  timerS: Maybe;
  distanceM: Maybe;
  avgSpeed: Maybe;
  maxSpeed: Maybe;
  avgHr: Maybe;
  maxHr: Maybe;
  avgCadence: Maybe; // spm
  totalAscentM: Maybe;
  intensity: string | null; // active | rest | warmup | cooldown | recovery | interval
  trigger: string | null; // manual | distance | time | ...
  workoutStepIndex: Maybe;
}

export interface NormalizedActivity {
  sport: string; // e.g. "running"
  subSport: string | null; // e.g. "treadmill", "trail", "generic"
  startTime: Date; // UTC
  /** Local time offset in seconds when the device provided it. */
  utcOffsetS: Maybe;
  device: { manufacturer: string | null; product: string | null; serial: Maybe };
  totals: {
    distanceM: Maybe;
    elapsedS: Maybe;
    timerS: Maybe;
    avgHr: Maybe;
    maxHr: Maybe;
    avgCadence: Maybe; // spm
    totalAscentM: Maybe;
    totalDescentM: Maybe;
    calories: Maybe;
    avgSpeed: Maybe;
    maxSpeed: Maybe;
  };
  laps: NormalizedLap[];
  streams: ActivityStreams;
  timerEvents: TimerEvent[];
  /** Non-fatal decoding issues. */
  warnings: string[];
}
