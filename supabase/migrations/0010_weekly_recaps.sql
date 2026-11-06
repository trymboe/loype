-- Weekly recap: one row per athlete per finished week (Monday–Sunday).
-- `estimates` freezes what the model said when the week was reviewed (VDOT,
-- race predictions, threshold, training load, goal-race prediction), so the
-- history can be compared later even after the model or plan changes.
-- `recap` is the review shown on the first visit of the next week.
-- Additive: no existing table changes.

create table public.weekly_recaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  estimates jsonb not null,
  recap jsonb not null,
  model_version text,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (user_id, week_start)
);
create index weekly_recaps_user_week_idx on public.weekly_recaps (user_id, week_start desc);

-- Writes go through the server (service role) after checking the session user.
alter table public.weekly_recaps enable row level security;
create policy weekly_recaps_select_own on public.weekly_recaps for select using (user_id = (select auth.uid()));
