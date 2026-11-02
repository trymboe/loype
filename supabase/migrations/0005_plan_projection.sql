-- "If you follow this plan" projection stored when a plan is generated, so later updates can be compared with it.
alter table public.training_plans add column projection jsonb;
