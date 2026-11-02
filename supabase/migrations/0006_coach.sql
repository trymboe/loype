-- Phase 5: AI coach conversations.
-- Every API message is stored verbatim (append-only) so a conversation can be
-- replayed exactly; display_text is what the chat shows. Writes go through the
-- server (service role) after checking the session user; the athlete can read
-- their own rows.

create table public.coach_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  -- the system prompt and model are frozen per conversation (see src/lib/coach/prompt.ts)
  prompt_version text not null,
  model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coach_conversations_user_idx on public.coach_conversations (user_id, updated_at desc);

create table public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.coach_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq int not null,
  role text not null check (role in ('user', 'assistant')),
  -- user: the athlete's message (+ data snapshot); assistant: the model's reply; tool_results: what the app's tools returned
  kind text not null check (kind in ('user', 'assistant', 'tool_results')),
  content jsonb not null,
  display_text text,
  snapshot_hash text,
  proposal_ids uuid[] not null default '{}',
  model text,
  usage jsonb,
  stop_reason text,
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create index coach_messages_user_idx on public.coach_messages (user_id);

-- Plan changes the coach proposes use the same accept / keep / undo flow as the planner's rules.
alter table public.adaptation_proposals drop constraint if exists adaptation_proposals_rule_check;
alter table public.adaptation_proposals add constraint adaptation_proposals_rule_check check (rule in ('A', 'B', 'C', 'D', 'coach'));
alter table public.adaptation_proposals add column if not exists conversation_id uuid references public.coach_conversations (id) on delete set null;
create index if not exists adaptation_proposals_conversation_idx on public.adaptation_proposals (conversation_id);

do $$
declare t text;
begin
  foreach t in array array['coach_conversations', 'coach_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;
