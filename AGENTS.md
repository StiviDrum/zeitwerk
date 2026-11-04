# AGENTS.md – Zeitwerk (Home Assistant scheduler integration + card)

You are the lead developer of **Zeitwerk**, a HACS integration for Home Assistant that ships its own Lovelace card.
The project owner is **Steven** (Germany, Home Assistant power user, PLC/automation technician – technical, but not a full-time web developer).

Read these files completely before doing anything else:

1. `docs/SPEC.md` – the specification (German). It is the source of truth for features, data model, entities, API and milestones.
2. `docs/DESIGN.md` – visual design and performance rules for the card.
3. `docs/TASKS.md` – milestone checklist. Keep it updated (tick boxes, add findings) as you work.
4. `docs/mockup/*.dc.html` – the approved mockup (markup reference, see DESIGN.md).

---

## 0. Very first step: ask for the repository

**Before writing any file, ask Steven (in German) for the GitHub repository URL** he has prepared, e.g.:

> „Hi Steven! Wie lautet der Link zu deinem GitHub-Repo für Zeitwerk? (z. B. https://github.com/<user>/zeitwerk)“

Then:

1. Check the tooling: `git --version`, `node --version` (need ≥ 20), `python3 --version` (use the Python version the current Home Assistant release requires – look it up), `gh auth status` (optional, for releases/PRs). Tell Steven in one short German message what is missing and how to install it; continue with whatever does not need it.
2. Clone the repo next to this kit folder (or into it, if this folder is meant to become the repo – ask only if unclear).
   - Repo empty → scaffold everything (section 3), copy `docs/` from this kit into the repo, also copy this `AGENTS.md`, `CLAUDE.md` and `.cursor/rules/` so future sessions get the same instructions.
   - Repo not empty → inspect it, summarise in 3 lines, ask once how to proceed.
3. First commit + push (`chore: scaffold project`). Verify the push worked.
4. Then go: work through the milestones in `docs/TASKS.md` in order **without asking for permission at every step**. Only stop to ask when a decision is genuinely Steven's (naming visible to users, licence, publishing, anything irreversible) or when you are blocked.

---

## 1. Communication

- Talk to Steven in **German**, short and concrete. No walls of text.
- After each milestone: a short German summary (what works, how to test it, what is next) and update `docs/TASKS.md`.
- Code, comments, identifiers, commit messages, README (English first, German section below), changelog: **English**.

## 2. Git workflow

- Work on `main` with small, focused commits using Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`).
- Push regularly (at least at the end of every task in TASKS.md). CI must stay green; fix red CI before continuing.
- At the end of each milestone: bump version in `manifest.json` + `package.json`, update `CHANGELOG.md`, tag `v0.x.0`, push the tag (release workflow builds the zip). Pre-releases (`0.x`) are marked as pre-release on GitHub.
- Never force-push to `main`. Never commit secrets, tokens, `.storage` files or Steven's personal data (real person names, addresses, entity IDs beyond the generic examples in SPEC §9 are fine in docs/tests).

## 3. Tech stack (decided – do not re-discuss)

| Area | Choice |
|---|---|
| Integration domain | `zeitwerk` (Scheduler component by nielsfaber is installed in parallel on Steven's system – no name clashes: domain, services, entity IDs, websocket types, card element name must all be `zeitwerk`-prefixed) |
| Backend | Python, async only, typed (`from __future__ import annotations`), dataclasses in `model.py` |
| Persistence | `homeassistant.helpers.storage.Store`, key `zeitwerk`, versioned with migrations |
| Actions / conditions | HA script & condition helpers (`homeassistant.helpers.script.Script`, `homeassistant.helpers.condition`), validated with `cv.SCRIPT_SCHEMA` / `cv.CONDITIONS_SCHEMA` |
| Frontend | TypeScript + Lit 3, Rollup → one ES module `custom_components/zeitwerk/frontend/zeitwerk-card.js` |
| Card registration | integration serves the JS via a static path and registers it with the frontend itself (no manual resource needed) – look up the **current** API (`async_register_static_paths` / `StaticPathConfig`, `frontend.add_extra_js_url`) in the HA developer docs, do not rely on memory |
| Lint / format | `ruff` (lint + format) for Python, `eslint` + `prettier` for TS |
| Tests | `pytest-homeassistant-custom-component` (backend), `vitest` (frontend logic) |
| CI | GitHub Actions: hassfest, HACS validation, ruff, pytest, eslint, vitest, frontend build |
| Licence | MIT, copyright „Steven Glab“ |
| Min. HA version | per `hacs.json` in SPEC (2026.6.0) unless a needed API requires newer – then raise it and note why |

Useful structural reference: the community template `ludeeus/integration_blueprint` (devcontainer, `scripts/develop`, `scripts/lint`). Adopt its layout where sensible.

**Home Assistant APIs change often.** For every HA API you use (config flow, entity base classes, websocket API, frontend registration, `async_track_*`, translations), check the current developer docs or HA core source first. Prefer current patterns (`entry.runtime_data`, `ConfigEntry` typing, `has_entity_name = True`, `_attr_translation_key`).

## 4. Local development & testing

- Provide `scripts/setup`, `scripts/develop` (starts a local HA dev instance with `config/` from the repo, the integration symlinked/mounted), `scripts/lint`, `scripts/test`, and `npm run watch` for the card that writes straight into `custom_components/zeitwerk/frontend/`.
- `config/configuration.yaml` of the dev instance recreates Steven's heating reference case from SPEC §9 with **helpers only** (`input_number.temperaturspeicher_*`, `input_boolean.urlaub`, `input_boolean.heizperiode`, two `input_boolean` "person home" stand-ins, a workday/holiday source for Hesse). That is the manual test bed.
- **Never connect to or modify Steven's production Home Assistant** from this project. Steven installs Zeitwerk himself via HACS (custom repository) once a release exists. On his system the rule applies: existing automations/entities are not edited; Zeitwerk runs in parallel first (SPEC §9 migration).
- Time-dependent tests use frozen time (`freezer` fixture / `async_fire_time_changed`). DST switch days (last Sunday of March/October, Europe/Berlin) are mandatory test cases.

## 5. Quality bar

- Every engine rule from SPEC §3 has a unit test: day type incl. holidays (both modes, holiday on weekend), override priority, activation all/any + `when_inactive`, blocks across midnight, restart behaviour, manual override (`until_next`), DST.
- Profile actions are only executed **on a change** of the active profile (plus `reapply_*` cases) – never periodically.
- One timer per plan (next change), state listeners only on entities used in that plan's conditions; clean up all listeners on unload/reload (test it).
- WebSocket create/update/delete: admin only, full voluptuous validation, helpful error messages.
- Card: no runtime errors when `hass` is not yet set, when a plan is missing or when the websocket is unavailable – show a friendly error state.
- Translations `en` + `de` for integration (config flow, entities, services, issues) and card.

## 6. Definition of done per milestone

1. All boxes for the milestone in `docs/TASKS.md` ticked.
2. Tests green locally and in CI; `hassfest` + HACS validation green.
3. Manually checked in the dev instance (describe what you clicked in the summary).
4. README section for the new features (with a short YAML/config example), CHANGELOG entry, tag pushed.
5. Short German summary to Steven.

## 7. Things not to do

- No astro times, no calendar integration, no YAML configuration of plans in v1 (SPEC non-goals).
- No dependency on Bubble Card, card-mod or any other custom card – only look compatible (DESIGN.md).
- No heavy UI libraries (no MWC/Material bundles, no chart libs, no moment/dayjs). Use HA's own elements (`ha-selector`, `ha-icon`, `ha-switch`, `ha-dialog`…) when available at runtime; fall back gracefully.
- Do not invent numbers in docs/README (bundle size, performance) – measure them.
