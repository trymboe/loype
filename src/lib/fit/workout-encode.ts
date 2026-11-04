/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Planned workout → FIT workout file (`fit-workout@1`), the manual fallback
 * when Intervals.icu isn't connected or a workout doesn't arrive on the watch.
 *
 * FIT allows one target per step, so each step gets its own: pace (as a
 * speed range) when it has one, otherwise heart rate (absolute bpm),
 * otherwise open. Distances are in cm and times in ms, as the FIT profile
 * stores them. Repeats use `repeatUntilStepsCmplt` pointing back at the
 * first step of the block.
 */
import { Encoder, Profile } from "@garmin/fitsdk";
import type { Step, Target } from "../planning/types";

export const FIT_WORKOUT_VERSION = "fit-workout@1";

type Leaf = Exclude<Step, { kind: "repeat" }>;

interface WorkoutStepMesg {
  messageIndex: number;
  wktStepName?: string;
  durationType: string;
  durationValue?: number;
  targetType: string;
  targetValue?: number;
  customTargetValueLow?: number;
  customTargetValueHigh?: number;
  intensity?: string;
  notes?: string;
}

const INTENSITY: Record<Leaf["kind"], string> = { warmup: "warmup", cooldown: "cooldown", run: "active", recover: "recovery" };
const NAME: Record<Leaf["kind"], string> = { warmup: "Warm up", cooldown: "Cool down", run: "Run", recover: "Recover" };

function targetFields(t: Target): Pick<WorkoutStepMesg, "targetType" | "targetValue" | "customTargetValueLow" | "customTargetValueHigh"> {
  if (t.paceFast != null && t.paceSlow != null && t.paceFast > 0 && t.paceSlow > 0) {
    // speed in mm/s (scale 1000); low = slower pace
    return { targetType: "speed", targetValue: 0, customTargetValueLow: Math.round((1000 / t.paceSlow) * 1000), customTargetValueHigh: Math.round((1000 / t.paceFast) * 1000) };
  }
  if (t.hrMin != null && t.hrMax != null) {
    // custom HR values above 100 are bpm + 100 (0–100 would mean % of max HR)
    return { targetType: "heartRate", targetValue: 0, customTargetValueLow: Math.round(t.hrMin) + 100, customTargetValueHigh: Math.round(t.hrMax) + 100 };
  }
  return { targetType: "open" };
}

export function workoutStepMessages(steps: Step[]): WorkoutStepMesg[] {
  const out: WorkoutStepMesg[] = [];
  const emit = (list: Step[]) => {
    for (const s of list) {
      if (s.kind === "repeat") {
        const first = out.length;
        emit(s.steps);
        out.push({ messageIndex: out.length, durationType: "repeatUntilStepsCmplt", durationValue: first, targetType: "open", targetValue: s.count });
        continue;
      }
      const dur = s.distanceM ? { durationType: "distance", durationValue: Math.round(s.distanceM * 100) } : s.durationS ? { durationType: "time", durationValue: Math.round(s.durationS * 1000) } : { durationType: "open" };
      out.push({
        messageIndex: out.length,
        wktStepName: (s.note ? `${NAME[s.kind]} – ${s.note}` : NAME[s.kind]).slice(0, 40),
        ...dur,
        ...targetFields(s.target),
        intensity: INTENSITY[s.kind],
        notes: s.target.label.slice(0, 80),
      });
    }
  };
  emit(steps);
  return out;
}

const asciiName = (s: string) =>
  s
    .replace(/×/g, "x")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o")
    .replace(/Ø/g, "O")
    .replace(/æ/g, "ae")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();

export function encodeWorkoutFit(w: { title: string; steps: Step[] }, now = new Date()): Uint8Array {
  const steps = workoutStepMessages(w.steps);
  if (!steps.length) throw new Error("This workout has no steps to export");
  const enc = new Encoder();
  const write = (num: number, m: Record<string, unknown>) => enc.onMesg(num as any, m as any);
  write(Profile.MesgNum.FILE_ID, {
    type: "workout",
    manufacturer: "development",
    product: 0,
    serialNumber: 0x10ad,
    timeCreated: now,
  });
  write(Profile.MesgNum.WORKOUT, {
    sport: "running",
    subSport: "generic",
    numValidSteps: steps.length,
    wktName: asciiName(w.title).slice(0, 40) || "Loype workout",
  });
  for (const s of steps) write(Profile.MesgNum.WORKOUT_STEP, s as any);
  return enc.close();
}

export function fitFileName(date: string, title: string): string {
  const slug = asciiName(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `loype-${date}-${slug || "workout"}.fit`;
}
