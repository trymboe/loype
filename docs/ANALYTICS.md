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

## Fitness model (Phase 2)

Code: `src/lib/analytics/fitness/` (pure, unit-tested in `tests/fitness.test.ts`), orchestration in `src/lib/fitness/service.ts`.
Two layers: **features** (`features@1`, from the streams, independent of the athlete) and the **model** (`fitness@1`, from features + physiology).
Changing max HR re-scores every run without re-reading streams. All estimates are tagged `estimated` with a confidence; loads and efficiency are `calculated`.

| Quantity | Method | Limitations |
|---|---|---|
| Max HR | Manual value if set; else the second-highest 20-s rolling mean HR across runs with reliable HR in the last 2 years (highest if < 3 runs); else Tanaka 208 − 0.7·age. | Observed max underestimates true max unless you've run all-out, which makes intensities read high and the VO2max estimate conservative. |
| Resting HR | Manual; else median of Garmin daily resting HR (last 30 days, ≥ 5 days); else median overnight average HR from sleep data (proxy). | The overnight average is typically within a few bpm of Garmin's resting HR. |
| HR zones | Karvonen, % of HR reserve: Z1 50–60, Z2 60–70, Z3 70–80, Z4 80–90, Z5 90–100. | |
| Intensity | Time-weighted HR over the steady part (after the first 5 min of moving time) as % of HR reserve. If HR is unreliable, estimated from pace: (VO2(v) − 3.5)/(VDOT − 3.5). | |
| Training load | Banister TRIMP from the per-bpm time histogram: Σ minutes · x · a · e^(b·x), x = HRR fraction, male a=0.64 b=1.92, female a=0.86 b=1.67. Non-running activities: from Garmin summary duration + average HR. Runs with unreliable HR: from pace-estimated intensity. | Average-HR TRIMP underestimates variable sessions. |
| Running load (`running-load@1`) | Per run, equivalent km = (km + ascent m / 100) × (1 + 0.5 · share of HR time in zone 4 + 1.0 · share in zone 5); without zones, from the score's intensity (1 below 75 % HRR, 1.5 at 90 %, 2 at 100 %). Climb rule: ITRA km-effort. Weights: Banister TRIMP per km at zone midpoints vs easy. Shown beside km in the weekly volume chart; used by the planner (see PLANNING.md). | Ascent is the device's total, so barometric vs GPS altitude differs. Downhill cost is not counted. |
| Fitness / fatigue / form | EWMA of daily TRIMP: CTL τ = 42 d, ATL τ = 7 d, TSB = CTL − ATL (before the day's load). | Trends in what you did, not a diagnosis. |
| Efficiency factor | Steady-part speed (m/min) ÷ average HR, runs ≥ 15 min with reliable HR and pace. Trend: Theil–Sen slope over easy/steady/long/recovery runs in 120 days, shown when ≥ 5 runs over ≥ 21 days. | Heat, hills, wind and fatigue lower EF on the day. |
| HR decoupling | (EF first half − EF second half) / EF first half of the steady part, runs ≥ 25 min. | |
| Best efforts | Fastest timer-time segment for 400 m … marathon within a run, start interpolated between samples; pauses excluded, stops included. Only runs with reliable pace count. | GPS distance error carries through. |
| Classification | Rules on name, intensity, duration vs your 8-week median, and pacing variability (60-s speed CV, fast bouts ≥ 30 s at > 115 % of median speed): race, intervals, long, threshold (≥ 85 % HRR), steady (77–85 %), easy, recovery (< 60 % and < 45 min). Manual override wins. | Heuristic; confidence shown. |
| VO2max equivalent | Daniels VDOT. Evidence in the last 90 days: (1) near-maximal performances (races, or best efforts ≥ 1.5 km at ≥ 90 % HRR): recency-weighted mean of the top 3; (2) otherwise the per-run HR–speed reading 3.5 + (VO2(v) − 3.5)/x (Swain: %HRR ≈ %VO2R), recency (30-day half-life) and duration weighted median of ≥ 3 runs (flat, steady, outdoor, 50–95 % HRR). Never below the VDOT of your best recent effort. Range: performance ±1.5–2.5; HR method ±1.96·√(MAD² + 3²)/√n (+1 if max HR isn't entered). | Withheld with < 3 readings. Heat in particular raises HR and lowers the HR-based reading. |
| Race predictions | Time at which VDOT(d, t) equals the estimate (bisection), at the estimate and both ends of the range. Endurance correction: slowed by min(12 %, 5 %·log₂(d / (1.5 × longest run in 8 weeks))) when the race is > 1.5 × your longest recent run; confidence lowered. | Assumes training for the distance. |
| Threshold | Pace at 86–88 % VO2max from VDOT; HR at 88 % of HR reserve. | Not a measured lactate threshold. |
| Snapshots | `fitness_snapshots`: today's values (contemporaneous) and one row per week for 52 weeks recomputed with only data dated on or before that week (retrospective). Keyed by model version. | |
