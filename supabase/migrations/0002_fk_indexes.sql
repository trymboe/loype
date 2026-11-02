-- Løype 0002: covering indexes for foreign keys flagged by the Supabase
-- performance advisor (cascading deletes and per-job counting scan otherwise).
create index if not exists activities_duplicate_of_idx on public.activities (duplicate_of) where duplicate_of is not null;
create index if not exists activity_laps_user_idx on public.activity_laps (user_id);
create index if not exists activity_splits_user_idx on public.activity_splits (user_id);
create index if not exists activity_streams_user_idx on public.activity_streams (user_id);
create index if not exists raw_sources_job_idx on public.raw_activity_sources (sync_job_id);
create index if not exists workout_feedback_user_idx on public.workout_feedback (user_id);
