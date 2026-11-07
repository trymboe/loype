-- Shoe mileage. `starting_distance_m` is what the shoe had before Løype
-- (previous km); the total is that plus the runs linked to it. At most one
-- default shoe per athlete; new runs get it on ingest. Writes go through the
-- server (service role) after checking the session user; the athlete can read
-- their own rows.

create table public.shoes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  brand text,
  model text,
  starting_distance_m double precision not null default 0 check (starting_distance_m >= 0),
  -- null: the app's default target (700 km)
  retire_at_distance_m double precision check (retire_at_distance_m > 0),
  is_default boolean not null default false,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);
create index shoes_user_idx on public.shoes (user_id, created_at);
create unique index shoes_one_default_per_user on public.shoes (user_id) where is_default;

alter table public.shoes enable row level security;
create policy shoes_select_own on public.shoes for select using (user_id = (select auth.uid()));

-- Set on ingest from the default shoe, then only by the athlete; reprocessing never writes it.
alter table public.activities add column shoe_id uuid references public.shoes (id) on delete set null;
create index activities_shoe_idx on public.activities (shoe_id);
