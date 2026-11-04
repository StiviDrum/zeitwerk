# Zeitwerk

Weekly schedules for Home Assistant built on **profiles** – like a thermostat
week program, but for any entity.

> **Status:** pre-release (0.x). The backend works; the card arrives in 0.2.
> Plans are created via the websocket API (see below) until the card editor exists.

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
| `sensor.zeitwerk_<plan>_profile` | current profile name | `profile_id`, `source` (`schedule`, `default`, `override:<id>`, `forced`, `inactive`, `disabled`), `day_type`, `is_holiday`, `forced_until`, `error` |
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
`end`; scheduled segments, max. 8 days).

## Development

Requirements: Git, Node.js ≥ 20, Python ≥ 3.14.2 (the version current Home
Assistant requires). Scripts are Bash (on Windows use Git Bash; native Windows
works – Unix-only modules are shimmed for local runs only, CI runs on Linux).

```bash
scripts/setup      # .venv + Python and npm dependencies
scripts/test       # pytest + vitest
scripts/lint       # ruff + eslint/prettier
scripts/develop    # local HA at http://localhost:8123 with ./config (heating test bed)
python scripts/seed_reference_plans.py --token <token>   # creates the 5 heating plans
cd frontend && npm run watch   # rebuilds the card into custom_components/zeitwerk/frontend/
```

## License

MIT © Steven Glab

---

## Deutsch

Zeitwerk ist eine Home-Assistant-Integration für Wochenpläne mit **Profilen**
(z. B. „Komfort“, „Absenkung“) und eingebauten Vorrang-Regeln (Urlaub,
niemand zu Hause). Die Karte bringt sie selbst mit (ab 0.2).

**Status:** Vorabversion. Das Backend läuft; Pläne werden bis zur Karte über
die WebSocket-API angelegt.

Installation über HACS → Benutzerdefinierte Repositories → Typ *Integration*,
danach unter *Einstellungen → Geräte & Dienste* „Zeitwerk“ hinzufügen.

Pro Plan gibt es einen Schalter (Plan an/aus), einen Profil-Sensor, einen
Sensor „Nächster Wechsel“ und einen Binärsensor „Aktiv“. Dienste:
`zeitwerk.apply`, `set_profile_value`, `skip_next`, `force_profile`,
`clear_force`.
