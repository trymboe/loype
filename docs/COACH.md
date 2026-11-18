# Coach

A chat coach on the Coach tab (floating button on phones, side menu on desktop). It talks with the athlete about their own runs, fitness, plan and routes, and changes things for them when asked.

## Model and API

Two providers, in this order (`src/lib/coach/llm.ts`):

1. **Claude** (Anthropic Messages API) when `ANTHROPIC_API_KEY` is set: model `claude-sonnet-5-5` (override with `COACH_CLAUDE_MODEL`), adaptive thinking at effort `high`, streamed.
2. **OpenAI** (Responses API) when `OPENAI_API_KEY` is set: model `gpt-6-luna` (override with `COACH_MODEL`), reasoning effort `high`, streamed.

Fallback: with both keys, every request goes to Claude first. If a Claude request fails (after one SDK retry) or Claude declines it (`stop_reason: "refusal"`) before any text reached the athlete, the rest of that reply runs on OpenAI. The next message tries Claude again. With only one key, that provider is used alone. Run check-ins (`checkin.ts`) follow the same order.

Storage and replay:
- Each stored message keeps the format of the provider that produced it. `llm.ts` converts a stored history to either format: Claude messages become Responses items and back (tool calls and results carry over; Claude thinking only goes back to Claude, OpenAI's encrypted reasoning only to OpenAI).
- A conversation is pinned to the primary model (`coach_conversations.model`). A conversation started on another model, or another prompt version, continues from its visible text only.
- Claude: the full history is replayed verbatim, thinking blocks and signatures included, so the history stays append-only. Requests send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`), so a block that no longer matches its conversation (e.g. after a failed turn was repaired) is dropped instead of failing the request. Top-level `cache_control` caches the system prompt, tools and history.
- OpenAI: `store: false`, nothing is kept at OpenAI. Reasoning comes back as encrypted content (`include: ["reasoning.encrypted_content"]`) and is stored with the conversation. `prompt_cache_key` per conversation.
- The instructions and tool list are fixed, so the prefix caches on both.

## Data the coach sees

Only the signed-in athlete's rows. Each message carries a snapshot (`src/lib/coach/data.ts`, `format.ts`) of the fitness model, recent runs, weekly volume, the plan's last and next 14 days, routes and wellness, with every number labelled measured / calculated / estimated. It's re-sent only when it changed or the day changed. Read tools reach further: runs, run detail, metric history, weekly volume, plan workouts, plan history, wellness, routes.

## What it can do (`src/lib/coach/tools.ts`)

Everything the athlete can do in the app for their plan, routes and runs, and a bit more:

| Tool | What it does |
| --- | --- |
| `edit_workout` | move, skip, restore, swap for easy or rest, lock, unlock |
| `replace_workout` | turn a session into another type (e.g. intervals into a long run), built by the planner |
| `add_workout` | add a session on a day |
| `set_workout_steps` | rewrite a session's structure |
| `change_plan_settings` | run days, runs per week, long-run day, weekly cap, intervals / long runs / strides, target time, weekly km, race name; recalculates the weeks ahead |
| `get_plan_overview` | the whole plan week by week (phase, target and planned minutes, every session with id) |
| `edit_plan` | up to 150 operations (move, skip, restore, replace, resize, add, lock, unlock) across the whole plan, checked as a whole (schedule, week-to-week jumps, first week vs recent running, long runs vs longest recent run), one version, one Undo |
| `scale_plan` | make every session in a date range ±% longer (all / easy / long sessions), same checks |
| `start_plan_earlier` | move a not-yet-started plan's start earlier and rebuild it from that week |
| `restore_plan_version` | go back to an earlier plan version |
| `respond_to_proposal` | accept or decline a pending adaptation proposal |
| `update_route`, `link_route_to_workout`, `save_run_as_route`, `delete_route` | routes |
| `save_run_feedback`, `set_run_type` | run check-ins and type corrections |

Not available: creating or deleting a plan, deleting data, account and password, Garmin connection, drawing routes on the map.

## Safety: warn, then let the athlete decide

Increases go through the app's own checks before they're applied: `loadIssues` (long-run jumps against the last 30 days, weekly and hard minutes, the same rules as the planner and the step editor), `validateSchedule` / `moveIssues` (hard days back to back, unavailable days), and for settings `settingsRisks` (runs per week, weekly cap and km target against the last 4 weeks, adding intervals, a faster target vs the prediction). If anything is flagged, the tool returns the warnings instead of acting; the coach explains them and only repeats the call with `confirmed: true` after the athlete agrees. Completed, locked (until unlocked) and race workouts can't be changed.

## Undo

Each tool round stores what it changed (`coach_messages.actions`, migration 0007) with the plan version from before. The chat shows the changes under the reply with an Undo button (`undoCoachActions`): it restores that version, removes sessions the coach added, and for settings changes restores the old settings and recalculates the weeks ahead. Route and run changes aren't undone by it.

## Check-in after key sessions

A run matched to a key session (long run, intervals, tempo/threshold, time trial, race, or anything the plan marks key) gets a one-to-two sentence check-in on its page (`src/lib/coach/checkin.ts`): did it hit the session's goal, and what it means for the plan, with an injury-risk warning when RPE, discomfort, legs or HR drift call for one. It's written from deterministic inputs (planned steps and targets, execution verdict, reps vs laps, laps, splits, steady-part HR drift, RPE and feedback, CTL/ATL/TSB going into the day, the 4 weeks up to the run) by one non-streamed call (`store: false`), fetched by the page after it renders (`POST /api/activities/[id]/checkin`), and cached in `coach_checkins` (migration 0012). The cache key is the check-in version, the matched workout and the feedback, so a new or changed RPE/feedback regenerates it. No API key or any error: nothing is shown. Tapping it opens the coach with the check-in as its first message, and the run's inputs go with the first question as `<run_context>`.

## Storage

`coach_conversations` and `coach_messages` (migration 0006), append-only. A conversation started on another model or prompt version continues from its visible text only.
