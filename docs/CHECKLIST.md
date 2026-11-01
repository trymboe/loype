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
- ⛔ Verify Personal API field names, data host and rate limits against a real key (needs Trym's key)
- ⏳ pg_cron 30-min schedule (needs the deployed URL + CRON_SECRET)
- ⏳ Manual FIT upload path (same pipeline, provider `upload`)
- ⏳ Data deletion UI (export exists)

## Phase 2 — Fitness intelligence
- ⏳ Activity classification, best efforts, threshold pace/HR, zones, race predictions with uncertainty, VO2max (withheld when unsupported), load trends, aerobic efficiency, fitness snapshots

## Phase 3 — Planning · Phase 4 — Intervals.icu export · Phase 5 — Coach, routes, polish
- ⏳ See `docs/ARCHITECTURE.md` §4
- ⛔ Phase 4 end-to-end needs an Intervals.icu API key and the vívoactive 5 for validation
- ⛔ Phase 5 coach needs an LLM API key
