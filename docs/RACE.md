# Race page, progress motivation and Today cards

How the numbers on the race page, the "Your training is paying off" section, personal milestones and the Today insight are calculated. All logic is pure and tested (`tests/race.test.ts`, `tests/progress-motivation.test.ts`).

## Race page (`/plan/race`)

Shown for the active plan's goal when it has a race distance (5 km, 10 km, half, marathon or a custom race). Code: `src/lib/race/`.

### Prediction vs target (`status.ts`)

- **Prediction** applies Daniels' VDOT formula to the current fitness estimate (`fitness_state.output.estimate`), with the same endurance correction as the Progress page (`endurancePenalty`: up to 12 % slower when the race is much longer than your longest run in the last 8 weeks). The range uses the estimate's lower and upper VDOT. Confidence drops one or two levels when the endurance correction applies.
- **Target VDOT** inverts that prediction by bisection, so "your target corresponds to VDOT 47.2" is on the same scale.
- **Verdict**, in order:
  - *ahead*: the prediction is already at or under the target.
  - *in range*: the target is inside the likely range (faster end ≤ target).
  - *projected*: the plan's projection (from PR #13, when the plan has one) reaches the target at its optimistic end.
  - *stretch*: otherwise. The text names the VDOT gap; it never claims a target is reachable when the data says otherwise.
- No estimate → no prediction (and the page says what evidence is needed).

### Race-day pacing (`pacing.ts`)

- Splits per kilometre for a finish time: the target, the current prediction, or the plan projection (the athlete picks).
- **Strategy**: *negative split* (default) runs the first half 1 % easier and the second half 1 % harder than even effort (~2 % difference between halves). *Even effort* holds the same effort throughout.
- **Course adjustment** (when a GPX course is uploaded): each kilometre's time is scaled by a grade factor, then everything is rescaled so the total equals the finish time.
  - Uphill: +3.3 % time per 1 % of grade.
  - Downhill: −1.8 % per 1 % down to −8 %; steeper descents give the benefit back (braking).
  - Grades are clamped to ±25 %.
  - This is a heuristic based on Daniels' rule of thumb (climbs cost more than descents return). We use it instead of Minetti's metabolic cost curve, which overstates downhill speed for real runners.
  - A GPX that isn't exactly the race distance is stretched to it, and the page warns when they differ by more than 3 %.

### GPX course (`gpx.ts`, table `race_courses`)

- Reads `trkpt` (or `rtept`) points with optional `<ele>`. Files are limited to 5 MB, and courses must be at least 400 m long.
- Elevation is smoothed over a 100 m distance window. Climb and descent are counted with a 2 m hysteresis so GPS or DEM jitter doesn't inflate them.
- Courses are stored simplified to at most 600 points (`[lng, lat, ele, cumulative m]`), one per goal (migration `0006_race_courses.sql`).

## Your training is paying off (`src/lib/progress/paying-off.ts`)

Compares the last 8 weeks (including the current week) with the 8 before. Each item shows its basis under "How this is calculated".

| Item | Calculation | Shown as a gain when | Shown as a decline when |
| --- | --- | --- | --- |
| Fitness | Weekly retrospective VDOT at the start of the block vs now | +0.5 or more | −0.5 or worse |
| Aerobic efficiency | Median m/min per heartbeat on easy/steady runs, last 4 weeks vs the 4 weeks before the block | +2 % or more | −2 % or worse |
| Volume | Average weekly km | +10 % or more | −20 % or worse |
| Consistency | Weeks with at least one run | 7+ of 8, or 2+ more weeks than before | 2+ fewer weeks |
| Long run | Longest run in each block | +10 % and +1 km | (not shown) |
| Best efforts | Fastest 1/5/10/21.1 km stretch in the block vs everything imported before it | Any new best | (not shown) |

Changes inside these thresholds are shown as steady. The overall state is:

- *Paying off*: more gains than declines. When a training cause (volume, consistency) and a fitness effect both improved, the summary links them.
- *A dip, not a verdict*: a fitness signal declined, or there are more declines than gains. The summary separates "less running explains it" from "running held up, so it may be fatigue, heat or a few off days".
- *Holding steady*: neither of the above.
- *Not enough recent running to judge*: fewer than 4 runs in the block.

## Personal milestones (`src/lib/progress/milestones.ts`)

From all imported runs. Best efforts only come from runs with reliable GPS.

- Longest run.
- The furthest "first" reached: 10 km, 15 km, half marathon, 30 km or marathon distance.
- Best 1 km, 5 km, 10 km and half-marathon stretches, with how much the latest record beat the previous one.
- Biggest week.
- Most consistent calendar month: most run days, with distance as the tie-break.
- Longest streak of weeks with at least one run (3 or more).
- Total distance passed: 100, 250, 500, 1000, 2500 or 5000 km.
- Highest weekly fitness estimate.
- **Back to previous fitness**: the latest time the weekly VDOT climbed back to within 0.3 of a level it had dropped at least 1.5 below.

A milestone reached in the last 14 days is marked *New*.

## Today cards

- **Latest insight** (`insight.ts`) is rule-based, not AI-written. The first rule that applies wins:
  1. A pending plan change.
  2. Race within 10 days.
  3. High fatigue: form ≤ −max(20, 40 % of fitness), with fitness ≥ 15.
  4. Fitness load rising more than 8 points a week.
  5. A new milestone. Run records rank above streaks and totals.
  6. The paying-off state.
- **Race goal**: countdown, predicted vs target and plan week, linking to the race page.
- **Fitness snapshot**: VDOT with its range, threshold pace and HR, and form (TSB), all labelled as estimates.
