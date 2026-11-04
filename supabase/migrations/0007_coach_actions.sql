-- The coach (now on the OpenAI API) changes the plan directly when asked,
-- so each tool round records what it changed, for the chat's Undo button.
alter table public.coach_messages add column if not exists actions jsonb not null default '[]'::jsonb;
alter table public.coach_messages add column if not exists undone_at timestamptz;
