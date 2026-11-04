# Development checklist

Legend: ✅ done · 🟡 partial · ⏳ pending · ⛔ blocked (needs credentials or hardware)

## Phase 1 — Foundations & Garmin ingestion
- ✅ Architecture, data model, feasibility, plan, risks (`docs/ARCHITECTURE.md`)
- ✅ Next.js app shell, mobile bottom nav / desktop side nav, dark & light themes, PWA manifest
- ✅ Single-user magic-link auth (Supabase) restricted to `ALLOWED_EMAIL`, RLS on all tables
- ✅ Supabase schema 0001 applied to project `loype`; private bucket for original files; security advisor clean
- ✅ Garmin Personal API client: key→token exchange, encrypted token cache, renewal < 1 h, 401 re-auth, retries/backoff with Retry-After, ZIP→FIT extraction
- ✅ Historical import from chosen date; incremental sync with 3-day overlap; resumable time-boxed ticks; per-item backoff; unavailable vs failed vs skipped; idempotent; cross-source dedupe; provenance
- ✅ FIT parsing + moving time, splits, data-quality flags (unit tests on generated FIT files)
- ✅ Wellness sync (resting HR, HRV, sleep, stress, Body Battery) — lenient field extraction, raw stored
- ✅ Today (week strip, latest run, 8-week volume), Activities list, Activity detail (synced pace/HR/cadence/elevation charts, map with cursor + lap highlight, splits, laps, quality notes, provenance, RPE check-in), Progress (weekly volume + consistency), Integrations (connect, sync now, import with progress), data export
- ✅ Verified against a real key: token endpoint needs `Accept: */*`; data host and Bearer header work; 433 activities imported
- ⏳ pg_cron 30-min schedule (needs the deployed URL + CRON_SECRET)
- ⏳ Manual FIT upload path (same pipeline, provider `upload`)
- ⏳ Data deletion UI (export exists)

## Phase 2 — Fitness intelligence
- ✅ Per-run features (`features@1`) and scores (`fitness@1`): TRIMP load, intensity (%HRR), efficiency factor, HR decoupling, HR-zone time, best efforts, classification with manual override
- ✅ Max/resting HR detection with manual override (More → Athlete profile)
- ✅ VO2max-equivalent (VDOT) with range + confidence, withheld when evidence is thin; race predictions with endurance correction; threshold pace/HR; pace and HR zones
- ✅ Fitness/fatigue/form (CTL/ATL/TSB) incl. cross-training from Garmin summaries; aerobic-efficiency trend
- ✅ Append-only snapshots (contemporaneous + weekly retrospective), recomputed after each sync
- ⏳ Validate estimates against a race or time trial result

## Phase 3 — Planning (`planner@1`, see `docs/PLANNING.md`)
- ✅ Goal setup (race distances, custom race, general/endurance/consistency/volume/maintain), availability, weekly time cap, session preferences
- ✅ Deterministic generator: phases, recovery weeks, taper, volume from your last 4 weeks, long-run progression, structured workouts with pace + HR targets and a "why"
- ✅ Plan page with phase chart, week calendar (planned vs run), workout detail, Today card
- ✅ Edits: move (with schedule warnings), lock, skip, swap to easy/rest; every change versioned and restorable
- ✅ Run ↔ workout matching, execution vs targets, missed sessions after a day of grace
- ✅ Adaptation proposals (fitness change / outperforming, missed sessions, fatigue, return after a break) with accept / keep / undo; goal change regenerates and keeps history
- ✅ Load-driven frequency, single-run spike limit, 2-week tapers, weekly refresh, race-time projection, evidence table
- ✅ Workout step editor (reps, durations/distances, intensities, own paces) with safety checks
- ✅ Month view with drag-to-move
- ✅ Proposals: explain further, accept only some of the changes
- ✅ Wellness signals (HRV, resting/sleeping HR, sleep, Body Battery) in the fatigue rule
- ✅ Rep-by-rep interval analysis (laps or stream): pacing, fade, HR drift, HR recovery
- ⏳ Validate against a few weeks of real training

## Phase 4 — Workout export (see `docs/WATCH.md`)
- ✅ Intervals.icu text encoder, idempotent bulk upsert by `loype-<id>`, delete on skip/rest/removal, resend on change
- ✅ Per-workout sync state with Intervals.icu parse check; "on your watch" only by athlete confirmation
- ✅ FIT workout file download per workout (manual fallback)
- ✅ Runs on every sync, the scheduled job and "Send" buttons; independent of Garmin import
- ⛔ End-to-end on the vívoactive 5: needs Trym's Intervals.icu account + watch (checklist in `docs/WATCH.md`)

## Phase 5 — Coach, routes, polish
- ✅ Routes (Routes tab in the main menu): draw a route that follows paths (Valhalla pedestrian costing tuned for running) or straight lines, drag/remove waypoints, undo, reverse, back to start; generate a loop of a chosen distance from a start point; "where I've run" layer; distance + estimated elevation profile; save, favourite, rename, edit, delete; GPX export; save any recorded run as a route; link a route to an upcoming planned workout (shown on the workout)
- ✅ Activity analysis: "Select" a stretch on the charts to highlight it on the map with its distance, time, pace, HR (+ drift), cadence and elevation; lap comparison (deltas vs a reference lap, pace spread, fade and HR rise across reps, pace/HR overlay by metres into the lap, one-tap "work laps"); activity GPX export
- ⏳ Routes: check loop generation and elevation against real places (routing service was unreachable from the dev sandbox; tested with a mock)
- ❌ AI coach chat: built, then removed at Trym's request (no LLM API usage in the app)
