# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
