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

## 0.1 – Backend core

- [x] `model.py`: Plan, Profile, DayType, Block, Override, Activation, Holidays, Options (dataclasses, to/from dict)
  - `schema.py`: structural + semantic validation (refs, overlaps on the 24 h circle, one day type per weekday, gaps allowed → default profile). Actions/conditions stored as given, validated with `cv.SCRIPT_SCHEMA` / `cv.CONDITIONS_SCHEMA` + HA async validators. `compat.py`: probatio/voluptuous.
- [ ] `store.py`: load/save, schema version 1, migration hook, debounced save
- [ ] Config flow: single instance, no options yet
- [ ] `engine.py`: day type resolution (incl. holidays both modes), active profile (activation → overrides → block → default), next change computation, blocks across midnight, one timer per plan, state listeners for condition entities, DST-safe via `dt_util`
  - Progress: pure maths done in `schedule.py` (day type, holidays both modes, midnight spill – today's block wins, 24:00, next change, preview, DST). All instants UTC internally (same-tz aware datetimes compare by wall time!). DST rule: gap times start at first valid instant; repeated hour holds the state of the end of the first pass. Runtime part (timer, listeners) still open.
- [ ] `executor.py`: run profile actions with `Script`, own `Context` so manual changes can be detected later
- [ ] Apply only on change; `reapply_on_start`; `reapply_on_profile_change`
- [ ] Entities per plan: `switch`, `sensor …_profile` (attributes per SPEC), `sensor …_next_change` (timestamp), `binary_sensor …_active`; one device per plan
- [ ] Services: `apply`, `set_profile_value`, `skip_next`, `force_profile` (+ plan CRUD services or websocket-only – decide, document in README)
- [ ] WebSocket API: `plans/list|get|create|update|delete|subscribe`, `preview`; admin checks; validation
- [ ] Tests: everything in AGENTS.md §5 that applies to the engine, incl. DST days and restart
- [ ] Dev instance: heating reference case created via websocket/service script (`scripts/seed_reference_plans.py`) and observed working
- [ ] Release v0.1.0

## 0.2 – Card: week grid + profile quick view

- [ ] Card registers itself (static path + extra JS url), appears in the card picker with preview
- [ ] `view: week`: header, status chips, profile sliders, day-type tabs, week grid, now-line (DESIGN.md)
- [ ] Tap block → editor sheet (profile, start/end steppers, preview, delete, save) – writes via websocket
- [ ] Long-press empty track → new block; overlap handling (new block splits/trims existing ones; unit-tested)
- [ ] Profile quick view: detect "single entity, single value" actions and render a matching slider/select/switch
- [ ] Live updates via subscribe; error/empty states; `de` + `en`
- [ ] Vitest: time maths, snapping, overlap/merge, midnight blocks
- [ ] Release v0.2.0

## 0.3 – Overrides, activation, manual override

- [ ] Rules page: overrides list (drag to sort), add/edit with HA condition editor, all/any toggle, live "aktiv" badge
- [ ] Activation: conditions, all/any, `when_inactive`, `reevaluate`; status in header („pausiert – …“)
- [ ] Manual override `until_next` (context-based detection), `ignore`, `minutes:<n>`; shown as hatch in grid/timeline
- [ ] Tests for all of the above
- [ ] Release v0.3.0 → Steven can start the parallel run of the heating plans (SPEC §9)

## 0.4 – Holidays, timeline, drag, copy day

- [ ] Holiday settings UI (source: Holiday calendar or Workday binary_sensor; mode off/like_day/own_day_type; next holidays preview)
- [ ] `view: timeline` with `tags` filter
- [ ] Drag block edges (touch + mouse, snap, keyboard alternative)
- [ ] „Tag kopieren auf …“ / „Auch übernehmen für“
- [ ] Release v0.4.0

## 0.5 – Polish

- [ ] Visual card editor (`getConfigElement`, `getStubConfig`)
- [ ] Plan creation wizard in the card (name, icon, profiles with target entity + values, initial day types)
- [ ] Complete translations, repairs/issues for broken entity references
- [ ] `compact` mode, light-theme check, `getGridOptions`
- [ ] Release v0.5.0

## 1.0 – Publish

- [ ] README with screenshots/GIF (light + dark), full docs of services, entities, websocket API
- [ ] Brand assets for HACS/home-assistant/brands if wanted (ask Steven)
- [ ] HACS default repository submission checklist (ask Steven before submitting)
- [ ] Release v1.0.0
