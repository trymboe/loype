# Sending workouts to the watch (Phase 4)

Løype publishes planned workouts to **Intervals.icu**, which forwards them to
**Garmin Connect**, which syncs them to the **vívoactive 5**. A downloadable
**FIT workout file** is the manual fallback. This path is separate from the
Garmin activity import: its own integration row, its own errors, and a
failure here never stops runs from importing.

## How it works

| Piece | Where | Notes |
|---|---|---|
| Text encoder `intervals-text@1` | `src/lib/integrations/intervals/encode.ts` | Steps → Intervals.icu workout text: `Warmup` / `Nx` / `Cooldown` blocks, `10m`, `1m30s`, `1km`, `400mtr` (`m` = minutes), absolute pace `4:50-5:02/km Pace` or `% HR` of the max HR set in Intervals.icu. Nested repeats are unrolled. |
| Client | `src/lib/integrations/intervals/client.ts` | Basic auth `API_KEY:<key>`, athlete `0` (or the entered id). `POST events/bulk?upsert=true` matched by `external_id = loype-<planned workout id>`; `PUT events/bulk-delete` by external id. |
| Decisions `outbound@1` | `src/lib/outbound/plan.ts` | Sends planned, non-rest workouts in the next 14 days; resends only when the content hash changes (date, steps, title, target mode); keeps an already-sent workout in sync wherever it moves; deletes the remote copy of an upcoming workout that is skipped, made rest, removed, or whose plan was replaced. Past workouts are never deleted. |
| Service | `src/lib/outbound/service.ts` | Runs after every sync (app open/focus, Sync button), from the scheduled job, and from "Send" buttons. |
| FIT export `fit-workout@1` | `src/lib/fit/workout-encode.ts`, `GET /api/workouts/:id/fit` | `file_id(type=workout)`, `workout(sport=running)`, `workout_step`s. Per step: speed range when a pace exists, otherwise absolute HR (bpm + 100), otherwise open. Repeats use `repeatUntilStepsCmplt`. Checked by decoding with Garmin's own decoder in tests. |

### Target choice
Intervals.icu can't mix pace and HR targets in one workout, and absolute pace
targets only reach Garmin when the athlete has a **Run threshold pace** in
Intervals.icu. So each workout uses pace when that's set, otherwise heart rate
(as % of Intervals.icu's max HR, so it resolves to the intended bpm),
otherwise cue-only steps. The Integrations page warns when the threshold pace
is missing.

### Sync states (`external_workout_syncs.state`)
| State | Shown as | Meaning |
|---|---|---|
| `sent` | Sent to Intervals.icu | HTTP success, parse not checkable |
| `parsed` | On Intervals.icu | Intervals.icu's parsed `workout_doc` has the same number of steps (repeats expanded) and targets as the plan |
| `mismatch` | Check on Intervals.icu | Stored, but parsed differently (details listed on the workout) |
| `on_watch` | On your watch | **You** confirmed it on the watch. Reset when the workout changes |
| `failed` | Not sent | Request failed; retried on the next sync |
| `removed` | Removed | Remote copy deleted |

Intervals.icu exposes no Garmin delivery status, so Løype never claims a
workout is on the watch unless you say so.

## Setup
1. Intervals.icu → Settings: connect Garmin, enable **Upload planned workouts**.
2. Sport settings → Run: set a threshold pace.
3. Developer settings: copy the API key (and athlete id) into Løype → More → Integrations.

## Hardware validation checklist (vívoactive 5)
Not yet done; tick off once checked on the real watch.
- [ ] An easy run (single step, pace range) appears in Garmin Connect's calendar within a few minutes of "Send".
- [ ] It syncs to the watch (Training → Workouts / calendar) after a phone sync.
- [ ] Threshold 4 × 6 min: warm-up, 4 repeats with recoveries and cool-down show as separate steps with the right durations.
- [ ] Pace alerts on the watch match the ranges in Løype (Intervals.icu may widen a range slightly on export).
- [ ] With no threshold pace in Intervals.icu, the HR version shows HR targets in the right bpm range.
- [ ] Moving a workout in Løype moves it in Garmin Connect (no duplicate).
- [ ] Skipping/making it rest removes it from Garmin Connect.
- [ ] Hill repeats (no pace) show as untargeted steps with the "Hill" cue.
- [ ] FIT fallback: copying the downloaded file to `GARMIN/NewFiles` over USB makes the workout appear on the watch. (If the watch ignores it, Garmin Connect can't import workout FIT files either; then the Intervals.icu path is the only automatic route.)
