-- Strava as an activity source (Apple Watch and other non-Garmin watches reach Løype through Strava).
-- Additive: widens two provider checks; existing rows are unaffected.

alter table public.integrations drop constraint if exists integrations_provider_check;
alter table public.integrations
  add constraint integrations_provider_check check (provider in ('garmin', 'intervals_icu', 'strava'));

alter table public.raw_activity_sources drop constraint if exists raw_activity_sources_provider_check;
alter table public.raw_activity_sources
  add constraint raw_activity_sources_provider_check check (provider in ('garmin', 'upload', 'strava'));

-- Each provider has its own job queue.
create index if not exists sync_jobs_provider_active_idx on public.sync_jobs (user_id, provider, status)
  where status in ('queued', 'discovering', 'processing');
