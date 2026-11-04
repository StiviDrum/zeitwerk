# Zeitwerk

Weekly schedules for Home Assistant built on **profiles** – like a thermostat
week program, but for any entity.

> **Status:** pre-release (0.x), feature complete for 1.0: backend, week view,
> timeline, rules page, holidays, manual override, plan wizard and visual card
> editor.

A plan says *when* a profile applies (week grid with day types such as
"workday" / "weekend" / "holiday"); a profile says *what* happens (any Home
Assistant actions, e.g. set a temperature). Overrides with priority
("vacation → away", "nobody home → away") and activation conditions are built
in. Zeitwerk ships its own Lovelace card, which registers itself – no manual
resource needed.

## How it decides

For every enabled plan, in this order:

1. Activation conditions not met → plan is *inactive* (does nothing, or applies
   `when_inactive: profile:<id>` once).
2. A forced profile (`zeitwerk.force_profile` / `skip_next`) is active → that profile.
3. First override whose conditions match (list order = priority) → its profile.
4. The block of the current day type → its profile.
5. Otherwise the plan's `default_profile`.

Profiles are applied **only when the result changes** (plus on start with
`reapply_on_start`, and after editing the active profile with
`reapply_on_profile_change`). Blocks with `end <= start` run across midnight
and keep the day type of their start day. Holidays (Holiday calendar or
Workday sensor) can be treated like a weekday (`like_day`) or as an own day
type (`own_day_type`).

Daylight saving time: a block starting inside the skipped hour (e.g. 02:30 in
March) starts at 03:00; during the repeated hour in October the state of the
end of the first pass is kept, so nothing switches twice.

## Installation (HACS, custom repository)

1. HACS → ⋮ → *Custom repositories* → `https://github.com/StiviDrum/zeitwerk`, type **Integration**.
2. Install **Zeitwerk**, restart Home Assistant.
3. *Settings → Devices & services → Add integration → Zeitwerk*.

## Card

The integration serves the card and registers it with the frontend itself –
no dashboard resource needed. Add it via *Edit dashboard → Add card → Zeitwerk*
(the picker preview shows your first plan; all options are available in the
visual editor) or in YAML:

```yaml
type: custom:zeitwerk-card
view: week                  # week | timeline
plan: wohnzimmer_heizung    # plan id (week view)
show_profile_sliders: true  # quick view of the profile values
time_step: 15               # minutes, used for new blocks and the editor steppers
compact: false              # hides sliders/legend, smaller grid
```

Timeline of all plans (optionally filtered by tag):

```yaml
type: custom:zeitwerk-card
view: timeline
tags: [heizung]   # optional; plans with any of these tags
title: Heizung    # optional
```

The timeline shows one band per plan for today (scheduled blocks, manual
override hatched, now-line), the current profile and value and the next
change („ab 22:00“ / „in 20 min“); plans not in their default profile get a
border in the profile colour.

What the week view does:

- Header with the current profile and value, the next change and the plan
  on/off switch; chips for day type, plan state and active override.
- **Profile sliders** for profiles that set exactly one value on one entity
  (`input_number`/`number` value, climate temperature, select option,
  brightness, position, percentage, on/off). Dragging calls
  `zeitwerk.set_profile_value` (debounced 400 ms; on touch screens the slider
  reacts only after a short hold, so scrolling never changes a value); on/off profiles are switched
  via the websocket API (admin).
- **Week grid** (display only) with a now-line: one row per weekday (plus
  „Ft“ for an own holiday day). **Tap a day** to open the **day editor**: all
  blocks of that day on a 24 h bar – tap a block to select it, tap an empty
  spot or „+ Block“ to add one, drag the handles or the block (snapped to
  `time_step`), change profile and times, delete. Blocks stay within the day
  (0:00–24:00). On **Save** pick further days (Mo–So, quick Mo–Fr / Sa–So /
  Alle) that get exactly this day plan – their old blocks are replaced.
  Internally weekdays with the same plan are grouped into day types
  automatically (so `day_type` attributes show names like „Mo–Fr“). Editing
  needs an admin user.
- **Rules** (one entry below the grid with a summary; „?“ explains them) → *Overrides*,
  *Activation*, *Holidays*, each on its own page.
- **Overrides / Activation**: overrides in
  priority order with a live *active* badge – drag the handle (or focus it and
  press ↑/↓) to reorder, tap to edit name, profile, all/any and conditions
  (Home Assistant's own condition editor; JSON fallback if it cannot be
  loaded). Activation: all/any, live ✓ per condition, "otherwise" behaviour
  (`when_inactive`) and immediate re-evaluation (`reevaluate`). A paused plan
  shows the reason in the header, e.g. „pausiert – Heizperiode: Aus“.
- **Holidays** (rules page): source (Holiday calendar or Workday sensor), mode
  off / like a weekday / own day (creates a „Feiertag“ day type with its own
  row and tab) and the next three holidays.
- A **manual override** shows as a chip („manuell bis 22:00“) and as a hatched
  range in today's row.

- **New plan** (admins): „+ Neuer Plan“ in the timeline, or when the card has
  no/an unknown plan. Pick the target entity (number, climate, select, light,
  cover, fan, switch …), name, icon, tags, profiles with values and colours,
  the default profile and a start layout (workday/weekend or every day). A
  card configured with an unknown `plan:` id creates the plan under that id.

Bundle size (0.6.0, minified): 146.4 KB, 36.8 KB gzip.

## Repairs

If a plan refers to entities that do not exist (profile targets, conditions,
holiday source), Zeitwerk raises a warning under *Settings → Repairs* naming
the plan and the missing entities. It disappears when the entities exist again
(checked on start, on plan changes and when the entity registry changes).

## Manual changes

`options.manual_override` decides what happens when someone changes a target
value by hand (any change whose context does not come from Zeitwerk):

| Value | Behaviour |
|---|---|
| `until_next` (default) | keep the manual value until the effective profile changes (next block, override, activation); no re-apply on restart or profile edit meanwhile |
| `ignore` | no detection; re-applies (restart, profile edit) overwrite the manual value |
| `minutes:<n>` | keep the manual value for *n* minutes (also across profile changes), then apply the current profile again |

Only the value a profile actually sets is watched (e.g. the climate
`temperature` attribute, not `current_temperature`), and a change to exactly
the value of the active profile counts as an echo, not as a manual change.
`zeitwerk.apply` and `zeitwerk.force_profile` end a manual override. The
profile sensor then carries `manual_override`, `manual_since`, `manual_until`,
`manual_entity`.

## Plan format

```yaml
id: wohnzimmer_heizung
name: Heizung Wohnzimmer
profiles:
  - id: comfort
    name: Komfort
    color: "#ff8b4a"
    actions:
      - action: input_number.set_value
        target: { entity_id: input_number.temperaturspeicher_wohnzimmer }
        data: { value: 22 }
  - id: eco
    name: Absenkung
    actions:
      - action: input_number.set_value
        target: { entity_id: input_number.temperaturspeicher_wohnzimmer }
        data: { value: 18 }
default_profile: eco
week:
  day_types:
    - { id: workday, name: Werktag, days: [mon, tue, wed, thu, fri],
        blocks: [{ start: "16:00", end: "22:00", profile: comfort }] }
    - { id: weekend, name: Wochenende, days: [sat, sun],
        blocks: [{ start: "09:00", end: "22:00", profile: comfort }] }
holidays: { source: calendar.deutschland_he, mode: like_day, like_day: sun }
overrides:
  - id: vacation
    name: Urlaub
    profile: eco
    conditions:
      - { condition: state, entity_id: input_boolean.urlaub, state: "on" }
options: { reapply_on_start: true, reapply_on_profile_change: true }
```

Full model: [docs/SPEC.md](docs/SPEC.md) §3.

## Entities (per plan, one device per plan)

| Entity | State | Attributes |
|---|---|---|
| `switch.zeitwerk_<plan>` | plan enabled | – |
| `sensor.zeitwerk_<plan>_profile` | current profile name | `profile_id`, `source` (`schedule`, `default`, `override:<id>`, `forced`, `inactive`, `disabled`), `day_type`, `is_holiday`, `forced_until`, `manual_override`, `manual_since`, `manual_until`, `manual_entity`, `error` |
| `sensor.zeitwerk_<plan>_next_change` | timestamp of next scheduled change (empty while an override is active) | `next_profile`, `next_profile_name` |
| `binary_sensor.zeitwerk_<plan>_active` | activation conditions met | `match`, `conditions` (each with `result`) |

## Services

| Service | Fields | Purpose |
|---|---|---|
| `zeitwerk.apply` | `plan` | apply the current profile now |
| `zeitwerk.set_profile_value` | `plan`, `profile`, `value`, optional `entity_id`, `key` | change a profile value (e.g. Comfort → 21 °C) |
| `zeitwerk.skip_next` | `plan` | keep the current profile through the next change |
| `zeitwerk.force_profile` | `plan`, `profile`, optional `duration` | force a profile (default: until the next change) |
| `zeitwerk.clear_force` | `plan` | end a forced/skipped profile |

```yaml
action: zeitwerk.force_profile
data:
  plan: wohnzimmer_heizung
  profile: comfort
  duration: "02:00:00"
```

## Websocket API

Creating, editing and deleting plans is websocket-only (admin): `zeitwerk/plans/list`
(`tag`), `zeitwerk/plans/get` (`plan_id`), `zeitwerk/plans/create` (`plan`),
`zeitwerk/plans/update` (`plan_id`, `plan`), `zeitwerk/plans/delete` (`plan_id`),
`zeitwerk/plans/subscribe` (optional `plan_id`; sends `init`, then
`added`/`updated`/`removed`), `zeitwerk/preview` (`plan_ids`, `tag`, `start`,
`end`; scheduled segments, max. 8 days), `zeitwerk/holidays/upcoming`
(`source`, optional `count`; next holidays of a calendar/Workday source).

## Development

Requirements: Git, Node.js ≥ 20, Python ≥ 3.14.2 (the version current Home
Assistant requires). Recommended: Linux or **WSL2** on Windows (clone the repo
inside the WSL home, e.g. `~/zeitwerk`; `http://localhost:8123` works from the
Windows browser). Native Windows (Git Bash) still works as a fallback – Unix-only
modules are shimmed for local runs only; CI always runs on Linux.

```bash
scripts/setup      # .venv + Python and npm dependencies
scripts/test       # pytest + vitest
scripts/lint       # ruff + eslint/prettier
scripts/develop    # local HA at http://localhost:8123 with ./config (heating test bed)
python scripts/seed_reference_plans.py --token <token>   # creates the 5 heating plans
cd frontend && npm run watch   # rebuilds the card into custom_components/zeitwerk/frontend/
```

Card preview without Home Assistant (mocked `hass`): build the card, run
`python3 -m http.server 8000` in the repo root and open
`http://localhost:8000/frontend/dev/preview.html` (`?theme=light`, `?lang=en`,
`?admin=0`, `?plan=missing`).

## License

MIT © Steven Glab

---

## Deutsch

Zeitwerk ist eine Home-Assistant-Integration für Wochenpläne mit **Profilen**
(z. B. „Komfort“, „Absenkung“) und eingebauten Vorrang-Regeln (Urlaub,
niemand zu Hause). Die Karte bringt sie selbst mit und registriert sie
automatisch.

**Status:** Vorabversion, Funktionsumfang für 1.0 komplett.

Karte: *Dashboard bearbeiten → Karte hinzufügen → Zeitwerk*, oder
`type: custom:zeitwerk-card` mit `plan: <id>`. Tag im Wochenplan antippen
= Tages-Editor (Blöcke hinzufügen/löschen/ziehen, beim Speichern weitere Tage
wählen, die diesen Tagesplan übernehmen), Profil-Regler ändern den
Wert im Profil (z. B. Komfort 22 → 21,5 °C). Vorrang, Aktivierung und Feiertage liegen gesammelt
unter „Plan-Einstellungen“. Neue Pläne legt man in der
Karte mit „+ Neuer Plan“ an (Ziel-Entität, Profile mit Werten, Standardprofil,
Start mit Werktag/Wochenende oder jeden Tag gleich). Fehlende Entitäten in
einem Plan erscheinen unter *Einstellungen → Reparaturen*. Unter „Regeln“: Vorrang-Regeln
(ziehen zum Sortieren, Bedingungen mit dem HA-Bedingungseditor) und
Aktivierung (alle/eine, „Sonst“, sofort neu bewerten), Feiertage (Quelle,
aus / wie Wochentag / eigener Tag, nächste Feiertage). Zeitleiste aller Pläne: `view: timeline`
(optional `tags: [heizung]`).

Manuelle Änderungen (`manual_override`): `until_next` hält den Handwert bis
zum nächsten Profilwechsel, `minutes:<n>` für n Minuten, `ignore` erkennt
nichts.

Installation über HACS → Benutzerdefinierte Repositories → Typ *Integration*,
danach unter *Einstellungen → Geräte & Dienste* „Zeitwerk“ hinzufügen.

Pro Plan gibt es einen Schalter (Plan an/aus), einen Profil-Sensor, einen
Sensor „Nächster Wechsel“ und einen Binärsensor „Aktiv“. Dienste:
`zeitwerk.apply`, `set_profile_value`, `skip_next`, `force_profile`,
`clear_force`.
