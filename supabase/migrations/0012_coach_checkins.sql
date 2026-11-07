-- Coach check-in: the coach's one-to-two sentence read of a key session (long
-- run, intervals, tempo/threshold, time trial or race), shown on the run's page.
-- One row per run, generated on first view. `input_hash` covers what should
-- trigger a new check-in (the athlete's RPE and feedback, the matched workout,
-- the check-in version); when it no longer matches, the text is regenerated.
-- `workout_id` is not a foreign key: plan rebuilds replace workout rows, and
-- the hash catches a run matched to a different workout.
-- Additive: no existing table changes.

create table public.coach_checkins (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  workout_id uuid,
  input_hash text not null,
  text text not null,
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coach_checkins_user_idx on public.coach_checkins (user_id);
create trigger t_coach_checkins_touch before update on public.coach_checkins for each row execute function public.touch_updated_at();

-- Writes go through the server (service role) after checking the session user.
alter table public.coach_checkins enable row level security;
create policy coach_checkins_select_own on public.coach_checkins for select using (user_id = (select auth.uid()));
