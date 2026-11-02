-- Phase 5: saved running routes (route planner) and linking a route to a planned workout.
-- Writes go through the server (service role) after checking the session user;
-- the athlete can read their own rows.

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- [[lng, lat], ...] after simplification (≈2 m tolerance)
  coords jsonb not null,
  -- elevation in metres per coordinate (null where unknown); null when not looked up
  elevations jsonb,
  -- the points the athlete placed (or the generator chose), so the route can be edited later
  waypoints jsonb not null default '[]'::jsonb,
  -- per segment between waypoints: true = follows paths (routed), false = straight line
  snapped jsonb not null default '[]'::jsonb,
  distance_m double precision not null,
  elevation_gain_m double precision,
  elevation_loss_m double precision,
  source text not null default 'drawn' check (source in ('drawn', 'loop', 'activity')),
  activity_id uuid references public.activities (id) on delete set null,
  routing_provider text,
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index routes_user_idx on public.routes (user_id, favorite desc, updated_at desc);
create index routes_activity_idx on public.routes (activity_id);
create trigger t_routes_touch before update on public.routes for each row execute function public.touch_updated_at();

alter table public.routes enable row level security;
create policy routes_select_own on public.routes for select using (user_id = (select auth.uid()));

alter table public.planned_workouts add column route_id uuid references public.routes (id) on delete set null;
create index planned_workouts_route_idx on public.planned_workouts (route_id);
