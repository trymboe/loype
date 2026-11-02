-- Phase 2: fitness intelligence.
-- Per-run features (from streams, independent of physiology), per-run scores
-- (depend on max/rest HR and the model version), daily load, append-only
-- fitness snapshots, and a cached copy of the latest full model output.

create table public.activity_features (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version text not null,
  features jsonb not null,
  computed_at timestamptz not null default now()
);
create index activity_features_user_idx on public.activity_features (user_id);

create table public.activity_scores (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  model_version text not null,
  trimp double precision,
  trimp_method text check (trimp_method in ('hr', 'pace_estimate')),
  intensity double precision,
  intensity_source text check (intensity_source in ('hr', 'pace')),
  ef double precision,
  decoupling_pct double precision,
  vo2max_from_hr double precision,
  zone_seconds int[],
  classification text not null,
  classification_confidence real not null default 0,
  classification_reasons jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now()
);
create index activity_scores_user_idx on public.activity_scores (user_id);

-- The athlete can correct the automatic classification; recomputation keeps it.
alter table public.activities
  add column classification_override text
    check (classification_override in ('recovery', 'easy', 'long', 'steady', 'threshold', 'intervals', 'race'));

create table public.daily_load (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  run_trimp double precision not null default 0,
  other_trimp double precision not null default 0,
  ctl double precision not null,
  atl double precision not null,
  tsb double precision not null,
  model_version text not null,
  primary key (user_id, date)
);

-- Append-only history. A contemporaneous row records what the model said on
-- that day; a retrospective row is recomputed later using only data dated on
-- or before as_of. Rows are keyed by model version, so a new model never
-- overwrites what an older one said.
create table public.fitness_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  as_of date not null,
  kind text not null check (kind in ('contemporaneous', 'retrospective')),
  metric text not null,
  value double precision,
  lower_bound double precision,
  upper_bound double precision,
  confidence text check (confidence in ('high', 'medium', 'low')),
  model_version text not null,
  evidence jsonb,
  computed_at timestamptz not null default now(),
  unique (user_id, kind, as_of, metric, model_version)
);
create index fitness_snapshots_lookup_idx on public.fitness_snapshots (user_id, metric, as_of);

create table public.fitness_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  model_version text not null,
  as_of date not null,
  inputs_fingerprint text not null,
  output jsonb not null,
  computed_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['activity_features', 'activity_scores', 'daily_load', 'fitness_snapshots', 'fitness_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;

-- Wellness: overnight average HR (resting-HR proxy when Garmin's resting HR is missing).
alter table public.wellness_daily drop constraint wellness_daily_metric_check;
alter table public.wellness_daily add constraint wellness_daily_metric_check check (metric in (
  'resting_hr', 'hrv_overnight_avg', 'hrv_status', 'sleep_seconds', 'sleep_score',
  'stress_avg', 'body_battery_high', 'body_battery_low', 'steps', 'sleep_avg_hr'
));

insert into public.wellness_daily (user_id, provider, calendar_date, metric, value, unit, raw, fetched_at)
select user_id, provider, calendar_date, 'sleep_avg_hr', (raw ->> 'avgHeartRate')::double precision, 'bpm', raw, fetched_at
from public.wellness_daily
where metric = 'sleep_seconds' and jsonb_typeof(raw -> 'avgHeartRate') = 'number'
on conflict (user_id, provider, calendar_date, metric) do nothing;

-- Body Battery high/low were read from "charged"/"drained" (amounts gained and
-- used), not the day's highest/lowest level. Re-extract from the stored values array.
update public.wellness_daily w
set value = x.v
from (
  select id,
    case when metric = 'body_battery_high'
      then (select max((e ->> 1)::double precision) from jsonb_array_elements(raw -> 'bodyBatteryValuesArray') e where jsonb_typeof(e -> 1) = 'number')
      else (select min((e ->> 1)::double precision) from jsonb_array_elements(raw -> 'bodyBatteryValuesArray') e where jsonb_typeof(e -> 1) = 'number')
    end as v
  from public.wellness_daily
  where metric in ('body_battery_high', 'body_battery_low') and jsonb_typeof(raw -> 'bodyBatteryValuesArray') = 'array'
) x
where w.id = x.id;
