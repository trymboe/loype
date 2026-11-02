-- 0006: calendar subscription feed, 30-minute background sync, in-app data deletion.
-- Additive only.

-- ---------------------------------------------------------------------------
-- Calendar feed: one secret URL per athlete. Server-only (service role);
-- the browser never reads this table directly.
-- ---------------------------------------------------------------------------
create table public.calendar_feeds (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token text not null unique check (length(token) >= 32),
  -- local clock time for timed events (HH:MM); null = all-day events
  start_time text check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text,
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz
);
alter table public.calendar_feeds enable row level security;
-- no policies on purpose: only the service role can read or write it

-- ---------------------------------------------------------------------------
-- Data deletion. Deletes every row the athlete owns in each public table that
-- has a user_id column, except the tables in p_keep. Discovers tables at run
-- time so tables added later are covered too, and retries in passes so
-- foreign-key order does not matter. Service role only.
-- ---------------------------------------------------------------------------
create or replace function public.delete_user_data(p_user uuid, p_keep text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining text[];
  todo text[];
  t text;
  n bigint;
  progressed boolean;
  result jsonb := '{}'::jsonb;
begin
  if p_user is null then
    raise exception 'p_user is required';
  end if;
  select coalesce(array_agg(c.table_name::text order by c.table_name), '{}')
    into remaining
  from information_schema.columns c
  join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'user_id'
    and tb.table_type = 'BASE TABLE'
    and not (c.table_name::text = any (coalesce(p_keep, '{}')));

  while cardinality(remaining) > 0 loop
    progressed := false;
    todo := remaining;
    foreach t in array todo loop
      begin
        execute format('delete from public.%I where user_id = $1', t) using p_user;
        get diagnostics n = row_count;
        result := result || jsonb_build_object(t, n);
        remaining := array_remove(remaining, t);
        progressed := true;
      exception when foreign_key_violation then
        null; -- a referencing table is still to be cleared; try again next pass
      end;
    end loop;
    if not progressed then
      raise exception 'Could not delete from: %', remaining;
    end if;
  end loop;
  return result;
end;
$$;
revoke all on function public.delete_user_data(uuid, text[]) from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Background sync every 30 minutes: pg_cron + pg_net call /api/cron/sync.
-- The bearer token is generated here and kept in Supabase Vault; the app
-- verifies it with verify_scheduler_token(), so no secret has to be copied
-- between Vercel and Supabase. Change the target with:
--   select vault.update_secret((select id from vault.secrets where name = 'loype_app_url'), 'https://…');
-- If Vercel Deployment Protection blocks the URL, store a bypass secret:
--   select vault.create_secret('<bypass>', 'loype_vercel_bypass');
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'loype_scheduler_token') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'loype_scheduler_token',
      'Bearer token pg_cron sends to /api/cron/sync'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'loype_app_url') then
    perform vault.create_secret('https://loype.vercel.app', 'loype_app_url', 'Base URL the scheduler calls');
  end if;
end $$;

create or replace function public.verify_scheduler_token(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_token) >= 32, false) and exists (
    select 1 from vault.decrypted_secrets where name = 'loype_scheduler_token' and decrypted_secret = p_token
  );
$$;
revoke all on function public.verify_scheduler_token(text) from public, anon, authenticated;
grant execute on function public.verify_scheduler_token(text) to service_role;

create or replace function public.trigger_scheduled_sync()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  tok text;
  bypass text;
  headers jsonb;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'loype_app_url';
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'loype_scheduler_token';
  select decrypted_secret into bypass from vault.decrypted_secrets where name = 'loype_vercel_bypass';
  if base is null or tok is null then
    return null;
  end if;
  headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'User-Agent', 'loype-scheduler');
  if bypass is not null then
    headers := headers || jsonb_build_object('x-vercel-protection-bypass', bypass);
  end if;
  return net.http_get(
    url := rtrim(base, '/') || '/api/cron/sync',
    headers := headers,
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function public.trigger_scheduled_sync() from public, anon, authenticated;

-- cron.schedule with an existing name replaces that job, so this is re-runnable.
select cron.schedule('loype-sync', '*/30 * * * *', 'select public.trigger_scheduled_sync()');
