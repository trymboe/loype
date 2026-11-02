/** Schedule checks used when a plan is generated or a workout is moved. Pure. */
import { addDaysIso, formatDay } from "../dates";
import { isDemanding, isHard, WORKOUT_LABEL, type WorkoutType } from "./types";

export interface ScheduleItem {
  id?: string;
  date: string;
  type: WorkoutType;
  status?: string;
}

export interface ScheduleIssue {
  date: string;
  message: string;
}

const dow = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function validateSchedule(items: ScheduleItem[], unavailableDays: number[] = []): ScheduleIssue[] {
  const live = items.filter((i) => i.type !== "rest" && i.status !== "skipped");
  const byDate = new Map<string, ScheduleItem[]>();
  for (const i of live) byDate.set(i.date, [...(byDate.get(i.date) ?? []), i]);
  const issues: ScheduleIssue[] = [];
  for (const [date, list] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length > 1) issues.push({ date, message: `${formatDay(date)} has ${list.length} sessions.` });
    if (unavailableDays.includes(dow(date))) issues.push({ date, message: `${formatDay(date)} is a day you marked as unavailable.` });
    const next = byDate.get(addDaysIso(date, 1)) ?? [];
    for (const a of list) {
      for (const b of next) {
        if ((isHard(a.type) && isDemanding(b.type)) || (isDemanding(a.type) && isHard(b.type))) {
          issues.push({ date, message: `${WORKOUT_LABEL[a.type]} on ${formatDay(date)} is the day before ${WORKOUT_LABEL[b.type].toLowerCase()}: two demanding days in a row raise injury risk and blunt the second session.` });
        }
      }
    }
  }
  return issues;
}

/** Issues that a proposed move introduces (compared with the schedule before the move). */
export function moveIssues(items: ScheduleItem[], id: string, newDate: string, unavailableDays: number[] = []): ScheduleIssue[] {
  const before = new Set(validateSchedule(items, unavailableDays).map((i) => i.message));
  const after = validateSchedule(
    items.map((i) => (i.id === id ? { ...i, date: newDate } : i)),
    unavailableDays,
  );
  return after.filter((i) => !before.has(i.message));
}
