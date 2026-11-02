-- Race page: an uploaded GPX course for a race goal (one per goal), simplified
-- to at most a few hundred points with smoothed elevation. Writes go through
-- the server after checking the session user; the athlete can read their own.
create table public.race_courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null unique references public.goals (id) on delete cascade,
  name text,
  file_name text,
  distance_m double precision not null,
  gain_m double precision,
  loss_m double precision,
  min_ele_m double precision,
  max_ele_m double precision,
  -- [[lng, lat, ele|null, cumulative distance m], ...]
  points jsonb not null,
  created_at timestamptz not null default now()
);
create index race_courses_user_idx on public.race_courses (user_id);

alter table public.race_courses enable row level security;
create policy race_courses_select_own on public.race_courses for select using (user_id = (select auth.uid()));
