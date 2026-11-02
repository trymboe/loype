# AI coach (`coach@1`)

The Coach tab is a chat with Claude that answers from the athlete's own data. The model interprets; it never computes fitness numbers, paces or plans, and it can't change anything without the athlete accepting.

## Pieces

| File | Role |
| --- | --- |
| `src/lib/coach/prompt.ts` | System prompt (versioned, frozen per conversation) |
| `src/lib/coach/format.ts` | Pure text formatting of runs, weeks, metrics, plan and the athlete snapshot; labels measured / calculated / estimated |
| `src/lib/coach/data.ts` | Loads the snapshot and tool data from Supabase |
| `src/lib/coach/tools.ts` | Typed tools (JSON schema with `strict: true`, re-validated with zod) |
| `src/lib/coach/proposals.ts` | Pure, deterministic builder for coach plan changes |
| `src/lib/coach/service.ts` | The conversation loop: streaming, tool rounds, storage |
| `src/app/api/coach/route.ts` | `POST` endpoint, streams newline-delimited JSON events |
| `src/components/coach/*` | Chat UI, small safe Markdown renderer |

## What the model sees

- **System prompt**: role, how the app's numbers are made, coaching principles (setbacks, no fabricated encouragement, not medical advice), what it may change, style.
- **Athlete snapshot** in the user turn, as `<athlete_data>`: fitness estimate with range and confidence, threshold, pace and HR zones, predictions, load (CTL/ATL/TSB), efficiency trend, best efforts, how VDOT / 10 km prediction / threshold / CTL moved over 4 weeks to 12 months (retrospective snapshots), 12 weeks of volume, the last 12 runs, the plan (goal, phases, last and next 14 days with workout ids), recent proposals and 7 days of wellness. It's re-sent only when the data changed or the day changed, so the history stays append-only.
- **Read tools**: `get_runs`, `get_run_detail` (laps, splits, matched workout and execution, decoupling halves, feedback), `get_metric_history`, `get_weekly_volume`, `get_plan_workouts`, `get_wellness`.

## Changing the plan

`propose_plan_change` is the only write. It accepts at most 7 edits of two kinds:

- **replace** a workout with an easy run, recovery run or rest; minutes may shorten it but never lengthen it (the coach can't add load);
- **move** a workout up to 7 days, not into the past and not past the end of the plan.

Locked, completed, skipped, missed and past workouts and the race itself are refused. Workout content comes from the planner's `buildWorkout`, so paces follow the plan's VDOT. Moves run the same schedule checks as manual moves, and their warnings are added to the card. The result is an `adaptation_proposals` row with `rule = 'coach'`, shown as a card in the chat and on the Plan tab, and decided with the normal accept / keep / undo (moves carry `toDate` on the change; undo moves it back). The coach can't change pace targets: that happens through the planner's own recalibration rule (A), which the prompt explains.

## Model and API

- Model: `COACH_MODEL`, default `claude-sonnet-5-5`, adaptive thinking (default), `effort: medium`, streaming.
- Prompt caching: top-level automatic `cache_control`, so tool rounds and follow-ups reuse the prefix.
- Refusal fallback: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- Up to 8 rounds per message; the last round sets `tool_choice: none` so the turn always ends with an answer.
- Every API message is stored verbatim in `coach_messages` and replayed as-is. When the prompt version or model changes, earlier reasoning blocks are dropped once rather than replayed; a 400 about thinking signatures triggers one retry without them.
- Bad tool input goes back to the model as an `is_error` tool result; nothing runs on it.

## Limits

- Untested against the live API until `ANTHROPIC_API_KEY` is set; the loop is tested with a scripted model (`tests/coach.test.ts`) and was run end to end against a mocked Claude API.
- No "explain further" button on planner proposals yet; asking the coach covers it.
