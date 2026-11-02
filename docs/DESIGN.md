# Løype design system

Short reference so new screens match the rest of the app. Tokens and component classes live in `src/app/globals.css`, React primitives in `src/components/ui.tsx`.

## Principles

- Neutral ink surfaces, one warm accent (`--accent`, the red-orange of a trail marker). Use the accent for emphasis and the active state, not for every button.
- Data has its own colours (`--pace`, `--hr`, `--cadence`, `--elev`, `--easy`, `--tempo`, `--intervals`, `--long`) so charts never compete with UI.
- Sentence case everywhere. No uppercase tracked labels.
- Numbers are the hero: big, tight, tabular (`.display`, `<Stat>`), with units small and muted.

## Type

Instrument Sans (one family). Page title 32px bold (`<PageHeader>`), card heading `.section-title` (15px semibold), metric caption `.label` (12px muted), date/context line `.eyebrow`.

## Colour tokens

`bg`, `surface`, `surface-2`, `surface-3`, `hairline`, `fg`, `fg-2`, `muted`, `subtle`, `accent`, `accent-fg`, `good`, `warn`, `danger`, plus the data colours above. All are Tailwind colours too (`bg-surface-2`, `text-good`, `bg-accent/12`). Light and dark follow the OS.

## Components

| Need | Use |
| --- | --- |
| Page title, back link, date line | `<PageHeader title eyebrow back={{ href, label }} action>` |
| Card | `.card` / `<Card>`; heading row `<CardHeader title aside>` |
| Metric | `<Stat label value unit hint size="xl" \| "lg" \| "md" \| "sm">` |
| Buttons | `.btn` + `.btn-primary` (main action, ink), `.btn-secondary`, `.btn-accent`; `.btn-sm`, `.btn-block` |
| Inputs | `.input` (and `.input-sm`); works on `input`, `select`, `textarea` |
| Toggle group | `.seg` with `<button aria-pressed>` children |
| Pill toggle | `.chip` with `aria-pressed` |
| Status | `<Badge tone="muted" \| "good" \| "warn" \| "hr" \| "accent">` |
| Settings row icon | `<IconTile color="var(--pace)">` |
| List separators | `.divide-hairline` on the parent |
| Chart tooltip | `.chart-tip`; grid stroke `var(--grid)`, axis ticks `var(--subtle)` 11px |
| Entrance animation | `.rise` on one element, `.stagger` on a list parent |
| Loading placeholder | `.skeleton` |
| Garmin sync status / sync now | `<SyncButton>` (reads `useSync()` from `SyncProvider` in the app layout) |
