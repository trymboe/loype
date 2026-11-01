# Analytics methods

Every derived number carries a method version (`src/lib/analytics/versions.ts`) and a provenance tag:
`device` (measured by the watch, read from the FIT file) or `calculated` (deterministic from recorded samples).
Model-based estimates (Phase 2+) will add `estimated` with confidence; LLM output will be tagged `ai`.

| Method | Version | Definition | Limitations |
|---|---|---|---|
| FIT parsing | `fit-parser@1` | Garmin FIT SDK; records → 1 Hz-or-smart-recording streams; cadence doubled to steps/min for running; `(0,0)` and out-of-range coordinates dropped; duplicate timestamps merged. | Multi-session files use the first session. |
| Moving time | `moving-time@1` | Interval between samples is *paused* if the timer was stopped, *moving* if speed ≥ 0.8 m/s (from Δdistance/Δt), else *stopped*. | Very slow hiking-type efforts may count as stopped. |
| Splits | `splits@2` | Fixed 1 km splits; only the last split can be partial (@2: the first split is no longer flagged partial when the first sample is a few metres past 0); sample intervals apportioned across boundaries by distance (linear interpolation). Pace = moving time / distance. HR/cadence time-weighted over moving intervals. Elevation with 2 m hysteresis. | Accuracy is bounded by the distance stream (GPS or accelerometer). |
| Data quality | `quality@1` | Rules: indoor/treadmill → pace unreliable; GPS coverage < 50% → pace unreliable; GPS jumps implying > 43 km/h on > 1% of points (or ≥ 5) → pace unreliable; GPS track vs device distance off by > 10% → pace unreliable; HR coverage < 50% → HR unreliable; HR within ±3 of cadence on > 25% of samples → cadence lock, HR unreliable; HR outside 30–230 → unreliable; < 5 min or < 1 km → not fitness evidence. `usableForFitness` = not too short and (pace or HR reliable). | Heuristics; thresholds documented in code constants. |
| Duplicates | `dedupe@1` | Same provider + external id is unique in the DB. Cross-source: start within 120 s, duration within 10 %, distance within 5 %. | Two genuinely separate runs starting within 2 min with near-identical length would be merged (very unlikely). |
| Weekly volume | — | Monday–Sunday local weeks; sum of distance and moving time; empty weeks kept. | |
| Chart pace | — | Centred ±8 s window over moving samples from the distance stream; blank while stopped/paused or slower than 15:00/km. | Display smoothing only; never used for fitness estimates. |

Wellness values are copied from Garmin when present; if a field can't be found the value is stored as `null` with the raw JSON kept for re-extraction. Nothing is estimated in their place.
