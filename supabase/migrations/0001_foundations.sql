-- Løype Phase 1: foundations, ingestion and activity storage.
-- Units: SI (metres, seconds, m/s, bpm, steps/min). Timestamps are UTC timestamptz.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Athlete profile (manual, editable inputs)
-- ---------------------------------------------------------------------------
create table public.athlete_profile (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  birth_year int check (birth_year between 1900 and 2100),
  sex text check (sex in ('female', 'male', 'other')),
  weight_kg numeric(5, 2) check (weight_kg > 0),
  max_hr int check (max_hr between 100 and 240),
  max_hr_source text check (max_hr_source in ('manual', 'observed', 'estimated')),
  resting_hr int check (resting_hr between 25 and 120),
  resting_hr_source text check (resting_hr_source in ('manual', 'garmin', 'estimated')),
  timezone text not null default 'Europe/Oslo',
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Integrations and sync bookkeeping
-- ---------------------------------------------------------------------------
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('garmin', 'intervals_icu')),
  status text not null default 'not_configured'
    check (status in ('not_configured', 'connected', 'needs_reauth', 'error')),
  -- AES-256-GCM ciphertexts (see src/lib/crypto). Never selectable by the browser.
  api_key_ciphertext text,
  secret_ciphertext text, -- cached access token
  token_expires_at timestamptz,
  api_key_fingerprint text, -- sha256 prefix of the API key the token was issued for
  api_key_expires_at date, -- user-entered reminder; Garmin does not expose it
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'garmin',
  kind text not null check (kind in ('historical', 'incremental', 'wellness', 'reprocess')),
  status text not null default 'queued'
    check (status in ('queued', 'discovering', 'processing', 'completed', 'failed', 'cancelled')),
  range_start date,
  range_end date,
  cursor jsonb not null default '{}'::jsonb,
  discovered int not null default 0,
  processed int not null default 0,
  failed int not null default 0,
  unavailable int not null default 0,
  skipped int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index sync_jobs_active_idx on public.sync_jobs (user_id, status) where status in ('queued', 'discovering', 'processing');

-- ---------------------------------------------------------------------------
-- Raw sources: exactly what the provider gave us. Also the processing queue.
-- ---------------------------------------------------------------------------
create table public.raw_activity_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('garmin', 'upload')),
  external_id text not null,
  activity_type text,
  start_time timestamptz,
  summary jsonb, -- provider summary JSON as received
  file_path text, -- storage path in bucket raw-activity-files
  file_sha256 text,
  file_bytes int,
  status text not null default 'discovered'
    check (status in ('discovered', 'downloaded', 'processed', 'failed', 'unavailable', 'skipped_type', 'duplicate')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  processed_at timestamptz,
  sync_job_id uuid references public.sync_jobs (id) on delete set null,
  unique (user_id, provider, external_id)
);
create index raw_sources_queue_idx on public.raw_activity_sources (user_id, status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Activities: derived from raw sources, fully re-derivable.
-- ---------------------------------------------------------------------------
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  raw_source_id uuid not null unique references public.raw_activity_sources (id) on delete cascade,
  name text,
  sport text not null,
  sub_sport text,
  start_time timestamptz not null,
  utc_offset_s int,
  local_date date not null,
  distance_m double precision,
  elapsed_s double precision,
  timer_s double precision,
  moving_s double precision,
  avg_speed_moving double precision,
  avg_hr double precision,
  max_hr double precision,
  avg_cadence double precision,
  elevation_gain_m double precision,
  elevation_loss_m double precision,
  has_gps boolean not null default false,
  is_indoor boolean not null default false,
  device_manufacturer text,
  device_product text,
  provenance jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  quality_score real,
  usable_for_fitness boolean not null default true,
  -- Manual corrections the user made. Reprocessing never overwrites these.
  manual_overrides jsonb not null default '{}'::jsonb,
  duplicate_of uuid references public.activities (id) on delete set null,
  parser_version text not null,
  derivation_versions jsonb not null default '{}'::jsonb,
  -- Simplified track for list thumbnails / maps: [[lng, lat], ...]
  route_preview jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index activities_user_time_idx on public.activities (user_id, start_time desc);

create table public.activity_streams (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  sample_count int not null,
  t real[] not null,
  distance real[],
  speed real[],
  hr real[],
  cadence real[],
  altitude real[],
  lat double precision[],
  lng double precision[],
  -- per-interval motion state: 'm' moving, 's' stopped, 'p' paused (length = sample_count - 1)
  motion_states text,
  created_at timestamptz not null default now()
);

create table public.activity_laps (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  lap_index int not null,
  start_offset_s double precision not null,
  elapsed_s double precision,
  timer_s double precision,
  distance_m double precision,
  avg_speed double precision,
  max_speed double precision,
  avg_hr double precision,
  max_hr double precision,
  avg_cadence double precision,
  total_ascent_m double precision,
  intensity text,
  trigger text,
  workout_step_index int,
  unique (activity_id, lap_index)
);

create table public.activity_splits (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  split_index int not null,
  split_length_m int not null default 1000,
  distance_m double precision not null,
  elapsed_s double precision not null,
  moving_s double precision not null,
  pace_s_per_km double precision,
  avg_hr double precision,
  avg_cadence double precision,
  elevation_gain_m double precision,
  elevation_loss_m double precision,
  partial boolean not null default false,
  method_version text not null,
  unique (activity_id, split_length_m, split_index)
);

create table public.workout_feedback (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  rpe int check (rpe between 1 and 10),
  legs text check (legs in ('fresh', 'normal', 'heavy', 'sore')),
  discomfort text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Wellness observations (supplementary signals, never required)
-- ---------------------------------------------------------------------------
create table public.wellness_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'garmin',
  calendar_date date not null,
  metric text not null check (metric in (
    'resting_hr', 'hrv_overnight_avg', 'hrv_status', 'sleep_seconds', 'sleep_score',
    'stress_avg', 'body_battery_high', 'body_battery_low', 'steps'
  )),
  value double precision,
  unit text,
  raw jsonb,
  fetched_at timestamptz not null default now(),
  unique (user_id, provider, calendar_date, metric)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger t_profile_touch before update on public.athlete_profile for each row execute function public.touch_updated_at();
create trigger t_integrations_touch before update on public.integrations for each row execute function public.touch_updated_at();
create trigger t_jobs_touch before update on public.sync_jobs for each row execute function public.touch_updated_at();
create trigger t_activities_touch before update on public.activities for each row execute function public.touch_updated_at();
create trigger t_feedback_touch before update on public.workout_feedback for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security: the signed-in user only sees their own rows.
-- Background jobs use the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'athlete_profile', 'integrations', 'sync_jobs', 'raw_activity_sources', 'activities',
    'activity_streams', 'activity_laps', 'activity_splits', 'workout_feedback', 'wellness_daily'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;

-- Writable from the client session (everything else is written server-side).
create policy workout_feedback_write_own on public.workout_feedback
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy athlete_profile_write_own on public.athlete_profile
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- The encrypted token column must never be readable from the browser:
-- replace the table-wide grant with a column list that omits it.
revoke select on public.integrations from anon, authenticated;
grant select (id, user_id, provider, status, token_expires_at, api_key_expires_at, last_success_at,
  last_error, last_error_at, settings, created_at, updated_at) on public.integrations to authenticated;

-- ---------------------------------------------------------------------------
-- Private storage for original activity files
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('raw-activity-files', 'raw-activity-files', false)
on conflict (id) do nothing;
