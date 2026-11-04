# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
