-- The AI coach chat was removed (no LLM usage in the app). Its tables were empty in prod.
drop index if exists public.adaptation_proposals_conversation_idx;
alter table public.adaptation_proposals drop column if exists conversation_id;
alter table public.adaptation_proposals drop constraint if exists adaptation_proposals_rule_check;
alter table public.adaptation_proposals add constraint adaptation_proposals_rule_check check (rule in ('A', 'B', 'C', 'D'));
drop table if exists public.coach_messages;
drop table if exists public.coach_conversations;
