import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso, todayIn } from "../dates";
import { fetchAll } from "../db/paginate";
import { GOAL_LABEL, type GoalKind } from "../planning/types";
import { buildCalendar, type FeedRace, type FeedWorkout } from "./ical";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CalendarFeed {
  token: string;
  startTime: string | null;
  timezone: string | null;
  createdAt: string;
  lastFetchedAt: string | null;
}

const fromRow = (r: any): CalendarFeed => ({
  token: r.token,
  startTime: r.start_time,
  timezone: r.timezone,
  createdAt: r.created_at,
  lastFetchedAt: r.last_fetched_at,
});

export const newFeedToken = () => randomBytes(24).toString("base64url"); // 192 bits, 32 chars

/** Feed tokens are base64url and exactly 32 characters. */
export const isFeedToken = (t: string) => /^[A-Za-z0-9_-]{32}$/.test(t);

export async function getFeed(db: SupabaseClient, userId: string): Promise<CalendarFeed | null> {
  const { data, error } = await db.from("calendar_feeds").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`calendar_feeds: ${error.message}`);
  return data ? fromRow(data) : null;
}

/** Creates the feed, or gives it a new token (the old URL stops working). */
export async function rotateFeed(db: SupabaseClient, userId: string, timezone: string | null): Promise<CalendarFeed> {
  const existing = await getFeed(db, userId);
  const { data, error } = await db
    .from("calendar_feeds")
    .upsert({
      user_id: userId,
      token: newFeedToken(),
      start_time: existing?.startTime ?? null,
      timezone: existing?.timezone ?? timezone,
      created_at: new Date().toISOString(),
      last_fetched_at: null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`calendar_feeds: ${error.message}`);
  return fromRow(data);
}

export async function setFeedTime(db: SupabaseClient, userId: string, startTime: string | null, timezone: string) {
  const { error } = await db.from("calendar_feeds").update({ start_time: startTime, timezone }).eq("user_id", userId);
  if (error) throw new Error(`calendar_feeds: ${error.message}`);
}

export async function disableFeed(db: SupabaseClient, userId: string) {
  const { error } = await db.from("calendar_feeds").delete().eq("user_id", userId);
  if (error) throw new Error(`calendar_feeds: ${error.message}`);
}

/** Renders the feed for a token, or null when the token is unknown. Uses the service role. */
export async function renderFeed(db: SupabaseClient, token: string, appUrl: string, now = new Date()): Promise<string | null> {
  if (!isFeedToken(token)) return null;
  const { data: feed } = await db.from("calendar_feeds").select("*").eq("token", token).maybeSingle();
  if (!feed) return null;
  const userId: string = feed.user_id;
  const { data: profile } = await db.from("athlete_profile").select("timezone").eq("user_id", userId).maybeSingle();
  const tz = feed.timezone ?? profile?.timezone ?? "Europe/Oslo";
  const from = addDaysIso(todayIn(tz, now), -28);

  const { data: plan } = await db.from("training_plans").select("id, goal_id").eq("user_id", userId).eq("status", "active").maybeSingle();
  let workouts: FeedWorkout[] = [];
  const races: FeedRace[] = [];
  if (plan) {
    const rows = await fetchAll<any>((a, b) =>
      db
        .from("planned_workouts")
        .select("id, date, type, title, objective, why, steps, duration_s, distance_m, key, status, updated_at")
        .eq("user_id", userId)
        .eq("plan_id", plan.id)
        .gte("date", from)
        .order("date")
        .order("id")
        .range(a, b),
    );
    workouts = rows.map((r) => ({
      id: r.id,
      date: r.date,
      type: r.type,
      title: r.title,
      objective: r.objective ?? "",
      why: r.why ?? "",
      steps: r.steps ?? [],
      durationS: r.duration_s ?? 0,
      distanceM: r.distance_m,
      key: !!r.key,
      status: r.status,
      updatedAt: r.updated_at,
    }));
    const { data: goal } = await db.from("goals").select("id, kind, name, race_date, distance_m, target_time_s").eq("id", plan.goal_id).maybeSingle();
    if (goal?.race_date && goal.race_date >= from) {
      races.push({
        id: goal.id,
        name: goal.name || GOAL_LABEL[goal.kind as GoalKind] || "Race",
        date: goal.race_date,
        distanceM: goal.distance_m,
        targetTimeS: goal.target_time_s,
      });
    }
  }
  // best effort; never fail the feed over bookkeeping
  await db.from("calendar_feeds").update({ last_fetched_at: now.toISOString() }).eq("user_id", userId);
  return buildCalendar(workouts, races, { appUrl, startTime: feed.start_time, timezone: feed.start_time ? tz : null, now });
}
