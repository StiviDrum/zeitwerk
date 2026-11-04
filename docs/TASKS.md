# TASKS.md – Zeitwerk milestone checklist

Tick boxes as you go (`- [x]`). Add short notes/findings under a task when useful. Milestones follow SPEC §8.

## M0 – Scaffold (before 0.1)

- [x] Ask Steven for the repo URL, clone, check tooling (see AGENTS.md §0)
  - Repo: https://github.com/StiviDrum/zeitwerk, cloned into `Zeitwerk/zeitwerk/` (kit folder stays outside).
  - Steven works on native Windows (no WSL2, no Docker). Python upgraded to 3.14.10; `gh` installed. HA needs `fcntl`/`resource` → `scripts/win_shims/` + Windows-only pytest plugin let `scripts/test` run natively; CI stays on Linux.
  - HA 2026.10 replaced `voluptuous` with `probatio` (drop-in API). Code must import via a compat shim so HA 2026.6 (min version) still works.
- [x] Copy `docs/`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/` from the kit into the repo
- [x] Repo layout per SPEC §6 (`custom_components/zeitwerk`, `frontend/`, `tests/`, `scripts/`, `config/`)
- [x] `manifest.json` (domain `zeitwerk`, `config_flow: true`, `iot_class: calculated`, `integration_type: service`, version `0.0.1`, codeowners, documentation + issue_tracker URLs from the repo URL), `hacs.json`
- [x] `pyproject.toml` (ruff config, pytest config), `requirements_test.txt` / dev deps
- [x] Frontend: `package.json`, `tsconfig.json`, Rollup config, Lit 3, ESLint + Prettier, Vitest; build output into `custom_components/zeitwerk/frontend/zeitwerk-card.js`
- [x] `scripts/setup`, `scripts/develop`, `scripts/lint`, `scripts/test`; `config/configuration.yaml` with the heating test bed (AGENTS.md §4)
  - Bash scripts (Git Bash on Windows). `develop` copies the integration into `config/custom_components` (no symlinks on Windows) – rerun after backend changes.
  - Holiday/Workday integrations are UI-only → add once via UI in the dev instance.
- [x] `.github/workflows/validate.yml` (hassfest, HACS action, ruff, pytest, eslint, vitest, build) and `release.yml` (on tag: build frontend, zip `custom_components/zeitwerk` as `zeitwerk.zip`, attach to GitHub release)
- [x] `.gitignore`, `LICENSE` (MIT, Steven Glab), `README.md` skeleton (en + de), `CHANGELOG.md`
- [x] First push, CI green
  - HACS validation only works on public repos → job skipped while the repo is private.
  - 2026-11-04: repo public, description + topics set → HACS validation runs and is green.

## 0.1 – Backend core

- [x] `model.py`: Plan, Profile, DayType, Block, Override, Activation, Holidays, Options (dataclasses, to/from dict)
  - `schema.py`: structural + semantic validation (refs, overlaps on the 24 h circle, one day type per weekday, gaps allowed → default profile). Actions/conditions stored as given, validated with `cv.SCRIPT_SCHEMA` / `cv.CONDITIONS_SCHEMA` + HA async validators. `compat.py`: probatio/voluptuous.
- [x] `store.py`: load/save, schema version 1, migration hook, debounced save
- [x] Config flow: single instance, no options yet
- [x] `engine.py`: day type resolution (incl. holidays both modes), active profile (activation → overrides → block → default), next change computation, blocks across midnight, one timer per plan, state listeners for condition entities, DST-safe via `dt_util`
  - Pure maths in `schedule.py` (day type, holidays both modes, midnight spill – today's block wins, 24:00, next change, preview, DST). All instants UTC internally (same-tz aware datetimes compare by wall time!). DST rule: gap times start at first valid instant; repeated hour holds the state of the end of the first pass. Runtime in `engine.py` (PlanRunner per plan) + `manager.py` (CRUD, storage, runners start via `async_at_started`). Holiday sources in `holidays.py` (calendar via `calendar.get_events`, workday via state + `workday.check_date`; Workday cannot detect a holiday on a non-working weekday). Extra sources: `disabled`, `forced`.
- [x] `executor.py`: run profile actions with `Script`, own `Context` so manual changes can be detected later
- [x] Apply only on change; `reapply_on_start`; `reapply_on_profile_change`
  - `last_applied` is persisted → with `reapply_on_start: false` a restart only applies if the profile changed meanwhile.
- [x] Entities per plan: `switch`, `sensor …_profile` (attributes per SPEC), `sensor …_next_change` (timestamp), `binary_sensor …_active`; one device per plan
  - Extra profile attributes: `forced_until`, `error`. next_change is empty while an override is active or nothing changes within 8 days.
- [x] Services: `apply`, `set_profile_value`, `skip_next`, `force_profile` (+ plan CRUD services or websocket-only – decide, document in README)
  - Decision: plan CRUD is websocket-only; services are for automations. Added `clear_force` to undo force/skip.
- [x] WebSocket API: `plans/list|get|create|update|delete|subscribe`, `preview`; admin checks; validation
  - subscribe sends `init` with all plans, then `added`/`updated`/`removed` events (plan incl. `status`).
- [x] Tests: everything in AGENTS.md §5 that applies to the engine, incl. DST days and restart
  - 67 tests (schema, schedule maths, engine, entities, services, websocket). Manual override tests come with 0.3.
- [x] Dev instance: heating reference case created via websocket/service script (`scripts/seed_reference_plans.py`) and observed working
  - Recommended dev environment since 2026-11-04: WSL2 Ubuntu 24.04, repo in `~/zeitwerk` (Python 3.14 from deadsnakes, Node 22 from NodeSource, git uses the Windows credential manager). `scripts/develop` symlinks the integration and lets HA install component requirements.
  - Fallback native Windows: `scripts/win_shims/run_hass.py` skips HA's OS check + signal handlers; `default_config` replaced by an explicit list (usb/dhcp/ffmpeg fail on Windows); `--skip-pip`.
  - Checked live: 5 plans seeded, vacation override, force/clear, set_profile_value, activation off/on, switch off, restart with reapply.
- [x] Release v0.1.0

## 0.2 – Card: week grid + profile quick view

- [x] Card registers itself (static path + extra JS url), appears in the card picker with preview
  - API checked against HA 2026.10.4 (`hass.http.async_register_static_paths` + `StaticPathConfig`, `frontend.add_extra_js_url`). URL carries a content hash (`?v=<sha256[:12]>`) → cache busting after updates and dev rebuilds. Async `getStubConfig` picks the first plan. Verified in the dev instance: module listed in the frontend index, file served identically.
- [x] `view: week`: header, status chips, profile sliders, day-type tabs, week grid, now-line (DESIGN.md)
  - Editor sheet is a native `<dialog>` (`showModal`, top layer) – not clipped by transformed dashboard containers, inherits theme variables. Header subline may wrap to two lines.
- [x] Tap block → editor sheet (profile, start/end steppers, preview, delete, save) – writes via websocket
  - „Auch übernehmen für“ chips belong to the 0.4 copy task. Editing requires admin; non-admins get a hint.
- [x] Long-press empty track → new block; overlap handling (new block splits/trims existing ones; unit-tested)
  - New block: 2 h or until the next block. A block with the default profile only clears its range. Touching blocks of the same profile are merged. Evening blocks ending 24:00 are never merged into a midnight block (would change which day type the morning belongs to).
- [x] Profile quick view: detect "single entity, single value" actions and render a matching slider/select/switch
  - Number (input_number/number min/max/step/unit, climate min/max_temp, %), select (`options`), on/off (`turn_on`/`turn_off`, changed via plans/update → admin). Values via `zeitwerk.set_profile_value`, 400 ms debounce, optimistic until the backend confirms.
- [x] Live updates via subscribe; error/empty states; `de` + `en`
  - `shouldUpdate` only reacts to the plan switch, quick-view entities, language and dark mode. Now-line: CSS var + caption text updated once a minute.
- [x] Vitest: time maths, snapping, overlap/merge, midnight blocks
  - 37 tests (time incl. DST via `Intl`, blocks/overlaps/midnight, row segments, quick view).
  - Manual UI check: `frontend/dev/preview.html` (mocked hass) clicked through in headless Chromium (edit, new block, slider, delete, plan switch, tabs, light/en, missing plan, non-admin) – no runtime errors. Steven still to try it in the real dev dashboard.
- [x] Release v0.2.0
  - Bundle 65.6 KB / 19.7 KB gzip.

## 0.3 – Overrides, activation, manual override

- [x] Rules page: overrides list (drag to sort), add/edit with HA condition editor, all/any toggle, live "aktiv" badge
  - Rules page and editors are in-card sub-pages, not modal dialogs: HA's condition editor opens its own dialogs at the document root, which a modal `<dialog>` would make inert. `ha-selector` is lazy → loaded via `loadCardHelpers` + tile card editor; JSON textarea fallback. Drag via pointer capture on the handle, ↑/↓ on the focused handle as keyboard alternative. Delete needs a second tap („Wirklich löschen?“).
- [x] Activation: conditions, all/any, `when_inactive`, `reevaluate`; status in header („pausiert – …“)
  - Pause reason = current state of the first failing condition's entity („Heizperiode: Aus“).
- [x] Manual override `until_next` (context-based detection), `ignore`, `minutes:<n>`; shown as hatch in grid/timeline
  - `manual.py`: per target only the value a profile sets is watched (climate `temperature`, light `brightness`, cover `current_position`, state otherwise); a change to exactly the active profile's value is an echo (devices reporting back with a fresh context). `until_next` holds while the effective profile is unchanged and blocks re-applies (restart, profile edit). `minutes:<n>` holds across profile changes and re-applies at the end. `apply` / `force_profile` end it. Timeline hatch follows with the timeline view (0.4).
- [x] Tests for all of the above
  - Backend 79 (10 new: until_next incl. restart and profile edit, echo, override ends manual, ignore, minutes both cases, apply/force, watch keys, attribute filter). Frontend 43 (condition summaries, pause reason, ids, reorder, zoned day maths). Rules page clicked through headless with the mocked preview (drag, keyboard reorder, all/any, when_inactive, reevaluate, add with validation, delete, activation editor, pause, manual chip) – no runtime errors. Not yet checked: HA's real condition editor inside the card (needs a logged-in dev instance).
- [x] Release v0.3.0 → Steven can start the parallel run of the heating plans (SPEC §9)
  - Bundle 99.0 KB / 27.3 KB gzip.

## 0.4 – Holidays, timeline, drag, copy day

- [x] Holiday settings UI (source: Holiday calendar or Workday binary_sensor; mode off/like_day/own_day_type; next holidays preview)
  - Section on the rules page. Sources = `calendar.*` + `binary_sensor.*` with a `workdays` attribute. `own_day_type` reuses a day type without weekdays or creates „Feiertag“. Preview via new `zeitwerk/holidays/upcoming` (works for sources no plan uses yet; Workday only knows ~8 days ahead – hint shown).
- [x] `view: timeline` with `tags` filter
  - Subscribes to all plans, `zeitwerk/preview` for today's segments (refetched 1 s after plan changes and at midnight). Clock and now-line updated per minute without re-render.
- [x] Drag block edges (touch + mouse, snap, keyboard alternative)
  - Invisible 22 px handles on both sides of an edge (44 px target), window-level pointer listeners so re-renders don't break the drag, click after drag suppressed. End may be dragged past midnight. Keyboard: ←/→ move, Shift = end, Alt = start (saved 0.8 s after the last key).
- [x] „Tag kopieren auf …“ / „Auch übernehmen für“
- [x] Release v0.4.0
  - Tests: backend 80, frontend 47 (`dragBlock`, `copyDayType`). Headless click-through of drag, keyboard, also-for, copy, holidays (own day type → tab + row), timeline (tag filter, manual hatch, empty state) – no runtime errors. Bundle 122.9 KB / 32.7 KB gzip.

## 0.5 – Polish

- [x] Visual card editor (`getConfigElement`, `getStubConfig`)
  - `ha-form` with select/boolean/number selectors (plan list from `plans/list`, tags with custom values); native fallback form. `getStubConfig` is async and picks the first plan.
- [x] Plan creation wizard in the card (name, icon, profiles with target entity + values, initial day types)
  - `wizard.ts` (pure, tested): domain → action (`set_value`, `set_temperature`, `select_option`, `light.turn_on` brightness_pct, cover position, fan percentage, turn_on/off). Entity picker via `ha-selector` (text + datalist fallback), `ha-icon-picker` if available. One target entity per wizard-created plan.
- [x] Complete translations, repairs/issues for broken entity references
  - `issues.py` (not `repairs.py`, that name is HA's platform for fixable flows). Checked on runner start, plan change and entity registry updates. en/de key sets identical (42 keys); card strings are type-checked for both languages.
- [x] `compact` mode, light-theme check, `getGridOptions`
  - Light theme: success chip text mixed with the text colour for contrast. Fixed label overflow on narrow blocks (found in the headless check).
- [x] Release v0.5.0
  - Backend 83 tests, frontend 54. Headless click-through of all views incl. wizard and editor (an earlier flaky run came from the test script's fixed 200 ms waits; now explicit waits, 10/10 green). Bundle 146.5 KB / 37.5 KB gzip.

## 0.5.1 – Fix found in Steven's first install

- [x] Card not found in the picker (endless spinner): HA imports `extra_modules` in parallel with `app.js`, which installs a scoped custom element registry polyfill and swaps `window.customElements`. Elements defined before the swap are invisible to HA ("Custom element not found"). Fix: `register.ts` defines all elements after `customElements.whenDefined("home-assistant")` (immediately outside HA). Unit-tested with a swapping fake registry.
  - Verified in the dev instance with a real login (headless Chromium, service workers blocked – a fresh profile otherwise reloads once while the SW installs): picker preview renders, week + timeline cards in a real dashboard, HA's condition editor in the override editor, HA entity + icon picker in the wizard. `Cannot read properties of undefined (reading 'addEventListener')` also appears on HA's history page → HA's own, not Zeitwerk.

## 0.5.2 – Feedback from Steven's first use

- [x] Edit single weekdays: block editor offers „Gilt für: Werktag (Mo–Fr) / nur Mittwoch“; `detachDay` moves the weekday into its own day type (reused if it already exists), tested.
- [x] Drag in the block editor: handles and the whole block in the preview bar (pointer capture, snapped).
- [x] „Cannot leave the window“: not reproducible here (desktop + touch emulation in real HA close fine). Removed the cause class anyway: the editor is an in-card page, no modal `<dialog>` any more (no focus/inert fights with HA dialogs or pop-ups).
- [x] Overrides / Activation / Holidays grouped as „Plan-Einstellungen“ (one entry with summary → menu → separate pages).
  - Verified in real HA on a touch-emulated phone: only-Wednesday save, handle drag 22:00 → 23:00, X closes a new block, all three settings pages and back.

## 0.6.0 – Day editor (Steven's redesign)

- [x] Main grid read-only, no tabs; tap a day → day editor (in-card page) with all blocks on a 24 h bar: add (tap empty / „+ Block“), select, delete, drag handles/blocks (stop at neighbours, 0:00/24:00), profile + steppers for the selected block.
- [x] Save → choose further days (Mo–So, Ft; quick Mo–Fr / Sa–So / Alle); their blocks are replaced. Discard confirmation for unsaved changes.
- [x] No blocks across midnight in the card (bundle 146.4 KB / 36.8 KB gzip); `weekToDays` splits existing ones (today's blocks win, as in the engine), `daysToWeek` regroups identical weekdays into day types (existing ids/names kept when the weekday set is unchanged, new ones named „Mo–Fr“, „Mi“).
- [x] Removed tabs, single-block editor, also-for, copy day. SPEC §5 and DESIGN updated.
  - Tests: frontend 72 (day-plan: split/regroup/apply, gaps, add, drag). Verified in real HA on a touch-emulated phone: drag 22→23, add 06:00 block, apply to Wed+Thu (others unchanged, regrouped), delete + X asks to discard and leaves the plan unchanged.

## 1.0 – Publish

- [ ] README with screenshots/GIF (light + dark), full docs of services, entities, websocket API
- [ ] Brand assets for HACS/home-assistant/brands if wanted (ask Steven)
- [ ] HACS default repository submission checklist (ask Steven before submitting)
- [ ] Release v1.0.0
