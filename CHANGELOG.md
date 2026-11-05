# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0-rc.1] - 2026-11-05

First public release candidate for 1.0 (no longer marked as pre-release on
GitHub, so HACS offers it without the beta switch).

### Added
- Diagnostics download for the integration (all plans) and per plan device.
- GitHub issue forms for bug reports and feature requests.
- Profiles can be reordered by dragging (or ↑/↓); the order is the slider
  order in the card.
- README screenshots (light and dark).

### Changed
- Rows lifted while dragging (profiles, overrides) are opaque.

## [0.8.3] - 2026-11-05

### Changed
- Code cleanup without functional or visual changes (verified by pixel
  comparison of all card pages): removed dead code from the old block dialog,
  shared page styles, cached localizers / time formatters / watched entities,
  CSS minified at build time (bundle 197.7 → 174.8 KB).
- Engine: the next change is searched lazily (stops at the first change) and
  an unchanged timer is kept instead of being re-created on every evaluation.
- English name for a new holiday day type when Home Assistant runs in English.

## [0.8.2] - 2026-11-05

### Added
- Edit plan in the card: name, icon and tags (the plan id stays), delete plan
  with confirmation.

### Changed
- „Regeln“ is now „Konfiguration“ with the sections *Regeln* (overrides,
  activation, holidays; „?“ help next to the heading) and *Plan* (edit,
  duplicate).

## [0.8.1] - 2026-11-05

### Changed
- Week grid: today's row is outlined.
- The chip row below the header is gone (weekday, „Plan läuft“, „kein
  Vorrang aktiv“). Only when the plan deviates from the week plan, one quiet
  line in the header says why: „Vorrang: Urlaub“, „manuell bis 22:00“,
  „Komfort bis 22:00“ (forced), „Feiertag“.
- README header renders in HACS (plain image with an absolute URL).

## [0.8.0] - 2026-11-05

### Added
- Profile editor in the card (gear next to „Profile“): name, icon, colour,
  default profile, 1–5 profiles, and what they switch – one entity for all
  profiles or own „entity → value“ lines per profile (e.g. light A in the
  morning, light B in the evening); HA action editor for anything else.
- Undo („Gespeichert · Rückgängig“, 10 s) after every change made in the
  card; refused when the plan changed elsewhere meanwhile.
- Duplicate a plan (rules page, wizard template, service
  `zeitwerk.duplicate_plan`, websocket `zeitwerk/plans/duplicate`); the copy
  starts switched off.
- Services `zeitwerk.enable` / `zeitwerk.disable`; `zeitwerk.apply` takes one,
  several or no plan (= all) and skips disabled plans.

### Changed
- Block labels adapt to the measured width: full span, start time, or none
  (hover/title shows the span).
- The „Jetzt … · nächster Wechsel …“ line below the week grid is gone (the
  header already shows it).
- A plan has at most 5 profiles. Removing a profile (card or `update_plan`)
  drops its blocks and points rules at the default profile.

## [0.7.0] - 2026-11-04

### Added
- Full control via services, e.g. for automations or an assistant (Claude via
  MCP): `get_plan` (response data incl. blocks per weekday and status),
  `set_day_plan`, `set_override`, `remove_override`, `update_plan`,
  `create_plan`, `delete_plan`. Editing requires an admin (automations
  without a user are allowed). Detailed de/en service descriptions explain the
  concepts and formats.
- Profile sensor attributes `plan_id`, `profiles` (id → name) and `overrides`
  (with `active`); the larger ones are excluded from the recorder.

## [0.6.2] - 2026-11-04

### Added
- Brand icon and logo (by Steven Glab): shipped in
  `custom_components/zeitwerk/brand/` (shown by Home Assistant for custom
  integrations that bring their own branding) and as README header.

## [0.6.1] - 2026-11-04

### Changed
- Week grid: dashed lines at 6, 12 and 18 o'clock, axis labels aligned to
  them, block times always as HH:MM (05:00–08:00).
- Day chip shows only the weekday (plus „Feiertag“ on holidays).
- „Plan-Einstellungen“ renamed to „Regeln“; „?“ buttons explain overrides,
  activation and holidays (click to expand, tooltip on hover).
- Profile sliders on touch screens react only after a short hold (350 ms), so
  scrolling the dashboard no longer changes values; keyboard support
  (arrows, Home/End).

## [0.6.0] - 2026-11-04

### Changed
- Week view is display-only; tapping a day opens the new **day editor**: all
  blocks of the day on one bar, add / select / delete, drag handles or blocks,
  profile and time per block, and on save choose further days that get the
  same day plan (their blocks are replaced). Unsaved changes ask before they
  are discarded.
- Blocks no longer cross midnight in the card (0:00–24:00); existing blocks
  across midnight are split into evening and next morning when a day is saved.
- Day-type tabs, the single-block editor, „Auch übernehmen für“ and
  „Tag kopieren auf …“ are gone. Weekdays with identical plans are grouped
  into day types automatically (backend format unchanged).

## [0.5.2] - 2026-11-04

### Added
- Edit a single weekday: „Gilt für: <Tagestyp> / nur <Tag>“ in the block
  editor detaches that weekday into its own day type.
- Drag the handles or the whole block in the editor's preview bar.

### Changed
- Block editor is an in-card page instead of a modal dialog (users could get
  stuck in the dialog, e.g. inside HA's own dialogs/pop-ups).
- Overrides, activation and holidays are grouped under one „Plan-Einstellungen“
  entry with a summary; each opens its own page.
- Deleting a block asks for confirmation (second tap).

## [0.5.1] - 2026-11-04

### Fixed
- Card not found / endless spinner in the card picker: Home Assistant loads
  integration modules in parallel with its app bundle, which replaces
  `window.customElements` (scoped registry polyfill). The card now defines
  its elements only after HA has defined `home-assistant`, so they land in
  the registry HA uses.

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
