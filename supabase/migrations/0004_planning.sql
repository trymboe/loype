-- Phase 3: goals, training plans, planned workouts, versions and adaptation proposals.
-- Writes go through the server (service role) after checking the session user;
-- the athlete can read their own rows.

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('5k', '10k', 'half', 'marathon', 'race', 'general', 'endurance', 'consistency', 'maintain', 'volume')),
  name text,
  distance_m double precision,
  race_date date,
  target_time_s double precision,
  target_weekly_km double precision,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index goals_user_idx on public.goals (user_id);

create table public.training_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'archived')),
  planner_version text not null,
  config jsonb not null,
  baseline jsonb not null,
  race_pace double precision,
  weeks jsonb not null,
  summary jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  current_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index training_plans_goal_idx on public.training_plans (goal_id);
create unique index training_plans_one_active on public.training_plans (user_id) where status = 'active';
create trigger t_plans_touch before update on public.training_plans for each row execute function public.touch_updated_at();

-- Full snapshot of the plan after every change, so any change can be inspected and undone.
create table public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.training_plans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version int not null,
  reason text not null,
  created_by text not null check (created_by in ('generator', 'athlete', 'adaptation')),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (plan_id, version)
);
create index plan_versions_user_idx on public.plan_versions (user_id);

create table public.planned_workouts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.training_plans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  original_date date not null,
  type text not null,
  title text not null,
  objective text not null default '',
  why text not null default '',
  steps jsonb not null default '[]'::jsonb,
  duration_s int not null default 0,
  distance_m double precision,
  key boolean not null default false,
  locked boolean not null default false,
  status text not null default 'planned' check (status in ('planned', 'completed', 'skipped', 'missed')),
  activity_id uuid references public.activities (id) on delete set null,
  match_score real,
  execution jsonb,
  source text not null default 'generator' check (source in ('generator', 'athlete', 'adaptation')),
  updated_at timestamptz not null default now()
);
create index planned_workouts_plan_date_idx on public.planned_workouts (plan_id, date);
create index planned_workouts_user_date_idx on public.planned_workouts (user_id, date);
create index planned_workouts_activity_idx on public.planned_workouts (activity_id);
create trigger t_planned_touch before update on public.planned_workouts for each row execute function public.touch_updated_at();

create table public.adaptation_proposals (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.training_plans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  rule text not null check (rule in ('A', 'B', 'C', 'D')),
  key text not null,
  title text not null,
  explanation text not null,
  evidence jsonb not null default '[]'::jsonb,
  changes jsonb not null,
  baseline_patch jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'undone', 'superseded')),
  resulting_version int,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (plan_id, key)
);
create index adaptation_proposals_user_idx on public.adaptation_proposals (user_id);

do $$
declare t text;
begin
  foreach t in array array['goals', 'training_plans', 'plan_versions', 'planned_workouts', 'adaptation_proposals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;
