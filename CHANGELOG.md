# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-11-04

### Added
- Plan creation wizard in the card (target entity → matching action,
  profiles with values and colours, default profile, start layout); reachable
  from the timeline and the "no plan" / "plan not found" states.
- Visual card editor (`getConfigElement`) with HA's form elements and a
  fallback form; plan dropdown, tags for the timeline.
- Repair issue when a plan refers to missing entities (en/de).

### Fixed
- Block labels no longer overflow narrow blocks.
- Better contrast of the "Plan läuft" chip in light themes.

## [0.4.0] - 2026-11-04

### Added
- Card `view: timeline` with `tags` filter and optional `title`: one band per
  plan for today (scheduled blocks, manual override hatched, now-line),
  current profile/value, next change („ab 22:00“ / „in 20 min“).
- Holiday settings on the rules page: source (Holiday calendar / Workday),
  mode off / like a weekday / own day type (created on demand), next
  holidays. New websocket command `zeitwerk/holidays/upcoming`.
- Drag block edges in the week grid (touch + mouse, snapped, live tooltip);
  keyboard: ←/→ move, Shift = end, Alt = start, Enter/Delete open the editor.
- „Auch übernehmen für“ in the block editor and „<day type> kopieren auf …“.

### Changed
- Day types without weekdays are only shown as a tab when they are the
  holiday day type.

## [0.3.0] - 2026-11-04

### Added
- Manual override detection: `until_next`, `ignore`, `minutes:<n>`. Watches
  only the value a profile sets per target; echoes of the active profile's
  value are ignored. Persisted across restarts; `apply` / `force_profile`
  end it. New profile sensor attributes `manual_override`, `manual_since`,
  `manual_until`, `manual_entity`; websocket status fields to match.
- Card rules page: overrides list with live active badge, drag (and ↑/↓) to
  reorder, add/edit/delete with Home Assistant's condition editor (JSON
  fallback), all/any; activation with all/any, live result per condition,
  `when_inactive` and `reevaluate`.
- Card: pause reason in header and chip („pausiert – Heizperiode: Aus“),
  manual override chip and hatched range in the week grid, rules links below
  the grid.

### Changed
- `zeitwerk.force_profile` now always applies the forced profile, even if it
  equals the last applied one.

## [0.2.0] - 2026-11-04

### Added
- Card `custom:zeitwerk-card`, `view: week`: header with current/next profile
  and plan switch, status chips, profile quick-view sliders (number, select,
  on/off), day-type tabs incl. holiday tab, week grid with blocks across
  midnight and a now-line (updated once a minute without re-render).
- Block editor sheet (profile, start/end steppers, preview, delete, save) and
  long-press on an empty track for a new block; overlapping blocks are trimmed
  or split, touching blocks of the same profile merged.
- Live updates via `zeitwerk/plans/subscribe`; friendly states for missing
  configuration, unknown plan, unavailable integration and non-admin users.
- `de` / `en` card strings; card picker entry with preview of the first plan.
- Standalone card preview with mocked `hass` (`frontend/dev/preview.html`).

### Changed
- Card URL is cache-busted with a hash of the bundle instead of the version.

## [0.1.0] - 2026-11-04

### Added
- Plans with profiles, day types, blocks (incl. across midnight), default
  profile, overrides with priority, activation conditions (all/any,
  `when_inactive`, `reevaluate`) and holidays (Holiday calendar or Workday
  sensor; `like_day` or `own_day_type`).
- Engine: one timer per plan, state listeners only for condition entities,
  profiles applied only on change, `reapply_on_start`,
  `reapply_on_profile_change`, DST-safe (Europe/Berlin switch days tested).
- Entities per plan: switch, profile sensor, next-change sensor, active binary
  sensor; one device per plan.
- Services `apply`, `set_profile_value`, `skip_next`, `force_profile`,
  `clear_force`.
- Websocket API `zeitwerk/plans/list|get|create|update|delete|subscribe` and
  `zeitwerk/preview` (create/update/delete admin only).
- Storage `.storage/zeitwerk` (version 1, migration hook).
- Dev tooling for native Windows, seed script for the heating reference plans.
### Added (scaffold)
- Project scaffold: integration skeleton with config flow, bundled card
  registration, frontend build (Lit + Rollup), CI (hassfest, HACS, ruff,
  pytest, eslint, vitest) and release workflow.
