# Løype — Architecture, Data Model, Feasibility, Plan and Risks

_Last updated: 2026-11-01. Living document; update when decisions change._

## 1. Architecture

One Next.js (App Router, TypeScript) application deployed on Vercel, backed by one
Supabase project (Postgres + Auth + Storage). No separate microservices.

```
┌──────────────────────────── Next.js on Vercel ─────────────────────────────┐
│  app/(app)/*            React UI (mobile-first PWA, Tailwind)               │
│  app/api/*              Route handlers: sync trigger, cron, feedback, export│
│                                                                            │
│  src/lib/integrations/  garmin/  intervals/ (Phase 4)  — HTTP clients only │
│  src/lib/ingest/        sync engine: discover → download → parse → store    │
│  src/lib/fit/           FIT decoding (@garmin/fitsdk) → normalized activity │
│  src/lib/analytics/     PURE functions: moving time, splits, quality,       │
│                         duplicates, zones, load, predictions (Phase 2+)     │
│  src/lib/planning/      PURE plan generation + adaptation rules (Phase 3)   │
│  src/lib/db/            Supabase clients + typed repositories               │
└────────────────────────────────────────────────────────────────────────────┘
          │ service role (server only)              │ user session (RLS)
          ▼                                         ▼
┌──────────────── Supabase ────────────────┐   Scheduler: Supabase pg_cron +
│ Postgres (schema in supabase/migrations) │   pg_net calls /api/cron/sync every
│ Storage bucket `raw-activity-files`      │   30 min (Vercel Hobby cron is daily
│ Auth (magic link, single allowed email)  │   only; vercel.json keeps a daily
└──────────────────────────────────────────┘   backstop).
```

Separation of concerns (spec §3):

| Concern | Location | Rule |
|---|---|---|
| Data ingestion | `lib/ingest`, `lib/integrations/garmin` | Only place that talks to Garmin. Idempotent. |
| Fitness calculations | `lib/analytics` | Pure, deterministic, versioned (`MODEL_VERSIONS`), unit-tested. No I/O. |
| Plan generation / adaptation | `lib/planning` | Pure, rule-based, tested against scenario fixtures. |
| Integrations | `lib/integrations/*` | Behind interfaces; outbound (Intervals.icu) independent of inbound (Garmin). |
| Presentation | `app/`, `components/` | Reads from DB; never computes fitness itself. |

Key technical decisions:

1. **FIT parsing in TypeScript with Garmin's official `@garmin/fitsdk`.** No Python service needed; one runtime, one test runner.
2. **Original files are kept forever** in a private Storage bucket, addressed by SHA-256. Every derived row records `parser_version` so we can reprocess everything when parsing improves (`reprocess` job type).
3. **Time series stored columnar**: one `activity_streams` row per activity with parallel arrays (time, distance, speed, HR, cadence, altitude, lat, lng). Loading a run's charts is one row read; storage stays small (≈1 M samples/yr would otherwise be 1 M rows). Full resolution is preserved; the FIT file remains the ultimate source.
4. **Durable, resumable sync without a queue service.** A `sync_jobs` row tracks a job; `raw_activity_sources` doubles as the work queue (`status`, `attempts`, `next_attempt_at`). Each invocation is time-boxed (~45 s), processes what it can, and the next tick continues. Exponential backoff per item; job-level errors are surfaced in the UI.
5. **Single-user auth**: Supabase magic link, plus `ALLOWED_EMAIL` enforced in middleware and the auth callback. RLS on every table (`user_id = auth.uid()`). Background jobs use the service-role key server-side only.
6. **Secrets**: Garmin Personal API key lives in a Vercel env var (`GARMIN_PERSONAL_API_KEY`). The 24 h access token is cached in `integrations.secret_ciphertext`, AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. Nothing secret is ever sent to the browser or logged.
7. **Provenance everywhere**: every number is tagged as `measured` (from device), `calculated` (deterministic from measured), `estimated` (model-based, with model version + confidence). The UI shows this.
8. **Maps**: MapLibre GL with OpenFreeMap vector tiles (OSM data, no API key). Routing for the route planner (Phase 5): OpenRouteService `foot-walking`/`foot-hiking` profiles or GraphHopper (needs a free key).
9. **Charts**: Recharts with a shared hover index so pace/HR/cadence/elevation charts and the map cursor are synchronized.

## 2. Data model

Phase 1 migration (`supabase/migrations/0001_foundations.sql`) creates the tables marked ●.
Later phases add the rest via new migrations; the shapes below are the plan.

**Identity & integrations**
- ● `athlete_profile` — user_id, display name, birth year, sex (optional), weight, max HR / resting HR (manual, with source), timezone, unit prefs, preferred days.
- ● `integrations` — provider (`garmin`, `intervals_icu`), status, encrypted token cache, token expiry, key expiry (user-entered reminder), last success/error.
- ● `sync_jobs` — kind (`historical`, `incremental`, `wellness`, `reprocess`), params (from/to), status, counters (discovered/processed/failed/unavailable/skipped), cursor, timestamps, last error.

**Raw observations (never mutated by analytics)**
- ● `raw_activity_sources` — (provider, external_id) UNIQUE; summary JSON as received; activity type; start time; file storage path + sha256 + size; status (`discovered`, `downloaded`, `processed`, `failed`, `unavailable`, `skipped_type`); attempts, next_attempt_at, last_error; fetched_at.
- ● `wellness_daily` — (user, date, metric, provider) UNIQUE; value, unit, raw JSON. Metrics: resting_hr, hrv_overnight_avg, sleep_seconds, sleep_score, stress_avg, body_battery_high/low.

**Derived activity data (re-derivable from raw)**
- ● `activities` — one per real-world run. Links to its raw source; sport/sub-sport; start (UTC + local + tz offset); distance; elapsed/timer/moving time; avg/max HR; avg cadence (spm); elevation gain/loss; has_gps; is_indoor; device; data-quality flags + score; `duplicate_of` (cross-source dedupe); manual overrides (JSON, never overwritten by reprocessing); `parser_version`.
- ● `activity_streams` — activity_id PK; parallel float arrays; sample count.
- ● `activity_laps` — device laps (start, elapsed, timer, distance, avg/max HR, avg speed, cadence, intensity/trigger, workout step index).
- ● `activity_splits` — computed per-km splits (calculated, with `method_version`).
- ● `workout_feedback` — activity_id, RPE 1–10, legs, discomfort, notes, created_at.

**Fitness model (Phase 2)**
- `model_versions` — name, version, description, released_at.
- `fitness_snapshots` — as_of date, metric (vo2max_est, threshold_pace, threshold_hr, race_pred_5k…, aerobic_efficiency, ctl/atl…), value, lower/upper bound, confidence, model_version, `computed_at`, `kind` (`contemporaneous` | `retrospective`), evidence (activity ids + reasons). Snapshots are append-only so history is never rewritten.
- `training_zones` — zone set (pace/HR), boundaries, derived_from snapshot, effective_from.
- `activity_classifications` — activity_id, class (easy/long/tempo/threshold/intervals/race/recovery), confidence, model_version, manual override.
- `best_efforts` — activity_id, distance, duration, start offset, reliability flag.

**Planning (Phase 3)**
- `goals`, `race_events` (with optional GPX course).
- `training_plans` → `plan_versions` (immutable snapshots; each adaptation creates a new version with diff + reason).
- `planned_workouts` (date, type, objective, targets, locked, status) → `workout_steps` (ordered, repeat groups, duration/distance, target pace/HR ranges).
- `workout_matches` — planned ↔ activity, match score, method.
- `adaptation_proposals` — trigger evidence, proposed diff, explanation, status (`pending/accepted/rejected/modified/undone`), resulting plan_version.

**Outbound + extras (Phase 4–5)**
- `external_workout_syncs` — planned_workout_id, provider, external_id (stable `loype-<uuid>`), payload hash, remote id, state (`pending/sent/parsed/mismatch/on_watch/failed/removed`), parse check, last checked (migration 0005, see `docs/WATCH.md`).
- `routes` (GeoJSON LineString, distance, elevation, favorite), `calendar_feeds`.

Units: SI everywhere in the DB (metres, seconds, m/s, bpm, steps/min, °C). Timestamps are `timestamptz` (UTC); local date stored separately for calendar logic.

## 3. Integration feasibility

### Garmin Connect Personal API — **feasible, primary source**
Verified from Garmin's docs and the official Python client README:
- Create a key at `connect.garmin.com/app/settings/personalApiToken` (30/90/180/365-day expiry, shown once).
- `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token` with `Authorization: ApiKey <key>` → JWT access token valid 24 h (or until key expiry). No refresh token: call again.
- Activities: `GET /activitylist-service/activities/search/activities?start&limit&startDate&endDate&activityType`, details `GET /activity-service/activity/{id}`, original file `GET /download-service/files/activity/{id}` (returns a ZIP; we extract the `.fit`).
- Wellness: sleep (`/sleep-service/sleep/dailySleepSummariesByDate`), HRV (`/hrv-service/hrv/daily/{start}/{end}`), stress (`/usersummary-service/stats/stress/daily/{start}/{end}`), Body Battery (`/wellness-service/wellness/bodyBattery/reports/daily`), daily summaries (`/usersummary-service/v2/dailysummaries`, likely holds resting HR).

Unverified until tested with a real key (handled defensively in code):
- Data-call base host (assumed `personal.connectapi.garmin.com`, overridable via `GARMIN_API_BASE_URL`) and `Authorization: Bearer` header.
- JSON field names (not in readable docs). The client parses summaries leniently and **treats the FIT file as the source of truth** for all activity metrics, so unknown summary fields cannot corrupt data.
- Rate limits (undocumented): we pace requests (~1/s), back off on 429/5xx, and honour `Retry-After`.
- Max `limit` per page: we use 50 and paginate until empty.

### Intervals.icu → Garmin Connect — **feasible for publishing; watch delivery must be validated on hardware**
- Basic auth `API_KEY:<key>`, base `https://intervals.icu/api/v1`, athlete id `0` = self.
- `POST /athlete/0/events/bulk?upsert=true` with `external_id` gives idempotent create/update; `PUT /athlete/0/events/bulk-delete` removes.
- Workouts as native text in `description` (moderator-recommended over `workout_doc`): `Warmup` / `Main Set` / `3x` repeats / `- 1km 4:45/km Pace`. Running pace targets survive Garmin export only when a Run threshold pace is set in Intervals.icu.
- Garmin delivery depends on the user's Intervals.icu ↔ Garmin link ("upload planned workouts" setting). There is **no API field confirming arrival on Garmin**, and forum reports of API-created workouts not syncing exist. We therefore track state as `sent to Intervals.icu` vs `verified on watch` (user confirmation), and provide a FIT workout file export fallback (the FIT SDK can encode `workout`/`workout_step` messages; the vívoactive 5 accepts workouts from Garmin Connect).

### vívoactive 5 — capabilities assumed
GPS, wrist HR, cadence, laps, structured workouts with pace/HR targets; no course navigation → routes stay web-only (spec §13). Running dynamics (GCT, vertical oscillation) and power are not expected; we don't depend on them.

### LLM — coach chat
OpenAI Responses API (`OPENAI_API_KEY`, model `gpt-6-luna`) with typed function tools that call the same planning services as the UI; increases pass the planner's safety checks and need the athlete's go-ahead. Fitness, zones, load and plan generation stay deterministic. See `docs/COACH.md`.

## 4. Prioritized implementation plan

**Phase 1 — Foundations & Garmin ingestion (this PR)**
1. App shell: mobile bottom nav (Today, Plan, Progress, Activities, Routes, More), dark/light theme, PWA manifest.
2. Supabase schema 0001 + RLS + storage bucket; single-user magic-link auth.
3. Garmin client: token acquisition/caching/renewal, retry/backoff, ZIP→FIT extraction.
4. Sync engine: historical import from a chosen date, incremental sync (overlap window), time-boxed resumable processing, per-item backoff, unavailable vs failed, duplicate detection, provenance.
5. FIT normalization + analytics core: moving time, pauses, per-km splits, data-quality assessment (GPS spikes, HR dropouts, indoor runs, missing elevation). Unit-tested with generated FIT files.
6. Activities list, activity detail (synced pace/HR/cadence/elevation charts, map with cursor, splits, laps, quality warnings, RPE check-in), Integrations page with import progress.
7. Wellness sync (resting HR, HRV, sleep, stress, Body Battery) stored as supplementary signals.

**Phase 2 — Fitness intelligence**: activity classification, best efforts, critical-speed / Riegel-style race model calibrated on races and hard efforts with endurance correction, VO2max via Daniels VDOT with confidence (withheld when evidence is weak), threshold pace/HR, HR zones (Karvonen/LTHR), TRIMP-based load (ATL/CTL as trends, not diagnoses), aerobic efficiency (pace-per-HR on comparable easy runs, HR decoupling), Progress page, snapshot history.

**Phase 3 — Planning**: goals/races, periodized generator, structured workouts with zone-derived targets, calendar (week/month, drag-to-move with validation), matching, adaptation rules for spec scenarios A–E, proposals with accept/reject/modify/undo, plan versioning.

**Phase 4 — Workout export**: Intervals.icu text encoder + bulk upsert, sync state per workout, FIT workout export, hardware validation checklist.

**Phase 5 — Premium**: insights ("Your training is paying off"), milestones, race page + pacing plan, routes (MapLibre + routing provider, GPX export), iCal feed + optional Google Calendar, animations.

## 5. Key risks and decisions

| Risk | Impact | Mitigation |
|---|---|---|
| Personal API field names/limits undocumented | Parsing breaks | FIT is the source of truth; summaries stored raw and parsed leniently; base URL configurable; first real run behind a "dry run" log. |
| Garmin key expires (≤ 1 year) | Sync silently stops | Store user-entered expiry; banner 14 days ahead; 401 → integration status `needs_reauth` shown on Today. |
| Garmin may change Personal API terms | Ingestion lost | Raw files kept; manual FIT upload path (same pipeline) as fallback. |
| Intervals.icu → Garmin sync unconfirmed for API workouts | Phase 4 promise | Separate states, user verification, FIT file fallback. |
| Vercel function time limits (60 s Hobby) | Long imports | Time-boxed, resumable batches; pg_cron ticks + "continue" polling from UI during import. |
| Vercel Hobby cron = daily | Late activities | Supabase pg_cron + pg_net every 30 min; manual "Sync now". |
| Wrist HR / GPS errors skew fitness | Wrong paces | Data-quality flags gate which activities count as evidence (Phase 2 consumes `quality.usable_for_fitness`). |
| Over-reacting to one great session | Bad adaptations | Phase 2/3: require ≥2 corroborating efforts or a race; shrink updates by confidence. |
| Storage growth | Free-tier limits | FIT files ~100–300 KB; columnar streams; ~1 GB lasts many years. |
