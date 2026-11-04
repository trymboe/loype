-- Phase 4: outbound workout sync state (Intervals.icu → Garmin Connect → watch).
-- One row per planned workout per provider. The row outlives the planned workout
-- (planned_workout_id is set null) so a remote copy can still be removed.
-- States:
--   pending      queued, not sent yet
--   sent         Intervals.icu accepted the request but its parse couldn't be checked
--   parsed       Intervals.icu stored the workout and its parsed steps match what we sent
--   mismatch     Intervals.icu stored it but parsed different steps/targets (see parse_check)
--   on_watch     the athlete confirmed the workout is on the watch (the only proof of delivery)
--   failed       the last attempt failed (see last_error); retried automatically
--   removed      deleted from Intervals.icu because the workout was removed/skipped/rested

create table public.external_workout_syncs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  planned_workout_id uuid references public.planned_workouts (id) on delete set null,
  provider text not null default 'intervals_icu' check (provider in ('intervals_icu')),
  external_id text not null,
  remote_id text,
  workout_date date not null,
  payload_hash text,
  target_mode text,
  state text not null default 'pending'
    check (state in ('pending', 'sent', 'parsed', 'mismatch', 'on_watch', 'failed', 'removed')),
  parse_check jsonb,
  last_error text,
  last_sent_at timestamptz,
  last_checked_at timestamptz,
  confirmed_on_watch_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index external_workout_syncs_workout_idx on public.external_workout_syncs (planned_workout_id);
create index external_workout_syncs_user_date_idx on public.external_workout_syncs (user_id, workout_date);
create trigger t_ext_syncs_touch before update on public.external_workout_syncs for each row execute function public.touch_updated_at();

alter table public.external_workout_syncs enable row level security;
create policy external_workout_syncs_select_own on public.external_workout_syncs for select using (user_id = (select auth.uid()));
