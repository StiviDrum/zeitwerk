# Projektbeschreibung: Zeitplan-Integration für Home Assistant (Arbeitstitel „Zeitwerk“)

> Startdokument für die Entwicklung in Cursor / Claude Code.
> Sprache dieses Dokuments: Deutsch. Code, Kommentare, Commit-Messages und Bezeichner: Englisch (wegen späterer Veröffentlichung).

---

## 1. Ziel

Eine Home-Assistant-Erweiterung, mit der sich **beliebige Entitäten** zeitgesteuert setzen lassen – mit einer Oberfläche, die so einfach zu bedienen ist wie ein Heizungsthermostat-Wochenprogramm, aber so flexibel wie eine Automation.

Kernidee: Ein Zeitplan arbeitet nicht mit einzelnen Aktionen pro Uhrzeit, sondern mit **Profilen** (z. B. „Komfort“, „Absenkung“). Ein Profil ist ein benannter Satz von Aktionen/Werten. Der Wochenplan legt fest, *wann* welches Profil gilt; die Profile legen fest, *was* dann passiert. Werte eines Profils lassen sich ändern, ohne den Zeitplan anzufassen.

Zusätzlich gibt es **Vorrang-Regeln (Overrides)**: Bedingungen, die – solange sie zutreffen – ein anderes Profil erzwingen (z. B. „niemand zu Hause → Abwesend“, „Urlaub an → Urlaub“).

### Abgrenzung zur bestehenden Scheduler-Komponente (nielsfaber/scheduler-component)

| | Scheduler-Komponente | Dieses Projekt |
|---|---|---|
| Modell | Zeitfenster → Aktion | Zeitfenster → **Profil** → Aktionen |
| Werte ändern | jeden Zeitslot einzeln | einmal im Profil |
| Vorrang (Abwesend/Urlaub) | über eigene Automationen | **eingebaut** (Overrides mit Priorität) |
| Ansicht | Liste von Plänen | **Wochenraster** pro Plan + **Zeitleiste** aller Pläne |
| Mehrere Pläne pro Ziel (Werktag/WE) | getrennte Pläne | **ein** Plan mit Tagesprofilen |
| Feiertage | nur über „workday“ (wie Wochenende) | wahlweise **wie ein bestimmter Tag** oder **eigener Feiertags-Tagestyp** |
| Plan nur unter Bedingungen aktiv | ja (alle/eine) | ja (alle/eine), plus Verhalten bei inaktivem Plan wählbar |

### Nicht-Ziele (v1)

- Keine Astro-Zeiten (Sonnenauf-/untergang) in v1 – vorgesehen für v1.x.
- Keine Kalenderintegration in v1.
- Kein Ersatz für Automationen mit komplexer Logik.

---

## 2. Architektur

Ein Repository, HACS-Kategorie **Integration**. Die Integration liefert die Karte mit und registriert sie selbst als Frontend-Ressource (kein manuelles Hinzufügen nötig).

```
Home Assistant
├── custom_components/zeitwerk/        (Python, Backend)
│   ├── Speicherung der Pläne (HA Storage, .storage/zeitwerk)
│   ├── Zeitsteuerung (async_track_point_in_time)
│   ├── Ausführung der Profil-Aktionen
│   ├── Override-Auswertung (State-Listener)
│   ├── WebSocket-API für die Karte
│   ├── Services (für Automationen)
│   └── Entitäten pro Plan (Switch, Sensoren)
└── Frontend: zeitwerk-card.js           (TypeScript + Lit, gebündelt)
    ├── Wochenraster-Editor
    ├── Zeitleiste aller Pläne
    └── Profil-Editor mit HA-Selektoren
```

### Warum keine reine Karte?

Eine Karte läuft nur im Browser, solange das Dashboard offen ist. Die Ausführung zu festen Zeiten muss im HA-Backend laufen.

### Warum nicht HA-eigene `schedule`-Helfer als Speicher?

Diese können nur an/aus (plus optionale Zusatzdaten) und sind nicht für mehrere Profile mit Vorrang-Logik ausgelegt. Eigener Speicher ist sauberer und erlaubt Migrationen.

---

## 3. Datenmodell

```yaml
plan:
  id: "wohnzimmer_heizung"          # slug, eindeutig
  name: "Heizung Wohnzimmer"
  enabled: true
  icon: "mdi:radiator"
  tags: ["heizung"]                 # zum Filtern in der Karte

  profiles:                          # benannte Aktionssätze
    - id: comfort
      name: "Komfort"
      color: "#ff7043"
      icon: "mdi:sun-thermometer-outline"
      actions:
        - action: "input_number.set_value"
          target: { entity_id: "input_number.temperaturspeicher_wohnzimmer" }
          data: { value: 22 }
    - id: eco
      name: "Absenkung"
      color: "#42a5f5"
      icon: "mdi:weather-night"
      actions:
        - action: "input_number.set_value"
          target: { entity_id: "input_number.temperaturspeicher_wohnzimmer" }
          data: { value: 18 }
    - id: away
      name: "Abwesend"
      color: "#9e9e9e"
      actions: [ ... ]

  default_profile: eco               # gilt außerhalb aller Blöcke

  activation:                        # optional: wann der Plan überhaupt läuft (wie Scheduler)
    match: all                       # all = alle Bedingungen | any = mindestens eine
    conditions:
      - { condition: state, entity_id: input_boolean.heizperiode, state: "on" }
    when_inactive: none              # none = nichts tun | profile:<id> = dieses Profil einmal anwenden
    reevaluate: true                 # bei Änderung der Bedingungen sofort neu bewerten
                                     #   (false = nur zu Blockgrenzen prüfen, Scheduler-Verhalten)

  holidays:                          # optional
    source: calendar.deutschland_he  # Kalender der Holiday-Integration ODER binary_sensor der Workday-Integration
    mode: like_day                   # off | like_day | own_day_type
    like_day: sun                    # bei like_day: Feiertag wird wie dieser Wochentag behandelt
    day_type: holiday                # bei own_day_type: id des Feiertags-Tagestyps

  week:                              # Tagesprofile -> Wochentage
    day_types:
      - id: workday
        name: "Werktag"
        days: [mon, tue, wed, thu, fri]
        blocks:
          - { start: "16:00", end: "22:00", profile: comfort }
      - id: weekend
        name: "Wochenende"
        days: [sat, sun]
        blocks:
          - { start: "09:00", end: "22:00", profile: comfort }
      - id: holiday                  # nur relevant bei holidays.mode = own_day_type
        name: "Feiertag"
        days: []                     # keine festen Wochentage, wird nur an Feiertagen verwendet
        blocks:
          - { start: "08:00", end: "23:00", profile: comfort }

  overrides:                         # Reihenfolge = Priorität (oben gewinnt)
    - id: vacation
      name: "Urlaub"
      profile: away
      match: all                     # all | any – wie bei activation
      conditions:
        - { condition: state, entity_id: input_boolean.urlaub, state: "on" }
    - id: nobody_home
      name: "Niemand zu Hause"
      profile: away
      match: all
      conditions:
        - { condition: state, entity_id: person.steven, state: "not_home" }
        - { condition: state, entity_id: person.alida, state: "not_home" }

  options:
    reapply_on_start: true           # nach HA-Neustart aktuelles Profil anwenden
    reapply_on_profile_change: true  # Profilwerte geändert -> sofort anwenden, wenn aktiv
    manual_override: until_next      # until_next | ignore | minutes:<n>
```

Hinweise:

- `actions` verwendet dasselbe Format wie HA-Skripte (`action`, `target`, `data`). Ausführung über `homeassistant.helpers.script.Script`, damit alles geht, was HA kann (inkl. Szenen, Skripte, Benachrichtigungen).
- `conditions` verwendet das HA-Bedingungsformat; Auswertung über `homeassistant.helpers.condition`.
- Ein Ziel kann von mehreren Profilen verwendet werden; ein Plan kann mehrere Entitäten steuern (z. B. Heizung + Licht).

### Unterschied Aktivierung vs. Override

- **activation** entscheidet, *ob* der Plan überhaupt läuft (z. B. nur in der Heizperiode, nur wenn jemand zu Hause ist). Ist der Plan inaktiv, schaltet er nichts – oder wendet optional einmalig ein festgelegtes Profil an (`when_inactive`).
- **overrides** entscheiden bei laufendem Plan, *welches Profil* statt des Wochenplans gilt.

Beide nutzen dieselbe Bedingungslogik mit `match: all | any`.

### Bestimmung des Tagestyps (inkl. Feiertage)

```
heute_ist_feiertag = holidays.source meldet Feiertag (Kalender-Termin heute bzw. Workday-Sensor)
wenn heute_ist_feiertag und holidays.mode == own_day_type: Tagestyp = holidays.day_type
wenn heute_ist_feiertag und holidays.mode == like_day:     Tagestyp = Tagestyp von holidays.like_day
sonst:                                                     Tagestyp, dessen days den heutigen Wochentag enthält
```

Validierung: Jeder Wochentag gehört zu genau einem Tagestyp (Karte zeigt Lücken/Doppelungen an). Der Feiertags-Tagestyp hat keine festen Wochentage.

### Ermittlung des aktiven Profils

```
für jeden Plan, wenn enabled:
    0. activation nicht erfüllt                           -> Plan inaktiv (when_inactive)
    1. erstes Override, dessen Bedingungen erfüllt sind  -> dessen Profil
    2. sonst Block, der jetzt laut Tagestyp gilt          -> dessen Profil
    3. sonst default_profile
```

Bei Blöcken über Mitternacht gilt der Tagestyp des Starttags (Block 22:00–06:00 am Freitag läuft bis Samstag 06:00).

Das Profil wird **nur bei einem Wechsel** angewendet (nicht periodisch), außer `reapply_*` greift.

### Manuelle Änderungen

`manual_override: until_next` – stellt jemand den Zielwert per Hand um, bleibt das bis zum nächsten Profilwechsel bestehen (Verhalten wie ein Thermostat). Erkennung: Zustandsänderung des Ziels mit einem `context`, der nicht von der Integration stammt.

---

## 4. Backend (custom_components/zeitwerk)

### Dateien

```
custom_components/zeitwerk/
├── __init__.py          # Setup, Laden der Pläne, Frontend-Registrierung
├── manifest.json
├── config_flow.py       # Einrichtung über die UI (keine YAML-Konfiguration)
├── const.py
├── store.py             # Persistenz, Schema-Versionen, Migrationen
├── model.py             # Dataclasses: Plan, Profile, DayType, Block, Override
├── engine.py            # Zeitberechnung, aktives Profil, Timer, Listener
├── executor.py          # Ausführung der Profil-Aktionen
├── websocket_api.py     # API für die Karte
├── services.yaml + services.py
├── switch.py            # switch.zeitwerk_<plan> (Plan an/aus)
├── sensor.py            # sensor.zeitwerk_<plan>_profile, _next_change
├── frontend/zeitwerk-card.js   # gebündelte Karte (Build-Artefakt)
└── translations/de.json, en.json
```

### Entitäten pro Plan

| Entität | Zustand | Attribute |
|---|---|---|
| `switch.zeitwerk_<plan>` | Plan aktiv an/aus | – |
| `sensor.zeitwerk_<plan>_profile` | aktuelles Profil (Name) | `profile_id`, `source` (`schedule` / `override:<id>` / `default` / `inactive`), `day_type`, `is_holiday` |
| `binary_sensor.zeitwerk_<plan>_active` | Aktivierungs-Bedingungen erfüllt | `match`, Liste der Bedingungen mit Einzelergebnis |
| `sensor.zeitwerk_<plan>_next_change` | Zeitstempel (device_class timestamp) | `next_profile` |

Damit lassen sich Automationen und Dashboards ohne Karte bauen.

### WebSocket-API (für die Karte)

| Typ | Zweck |
|---|---|
| `zeitwerk/plans/list` | alle Pläne (optional nach Tag gefiltert) |
| `zeitwerk/plans/get` | ein Plan |
| `zeitwerk/plans/create` / `update` / `delete` | Bearbeiten (nur Admin) |
| `zeitwerk/plans/subscribe` | Live-Updates bei Änderungen |
| `zeitwerk/preview` | aktive Profile für einen Zeitraum (für die Zeitleiste) |

Validierung aller Eingaben mit `voluptuous`; Aktionen und Bedingungen mit den HA-eigenen Validatoren (`cv.SCRIPT_SCHEMA`, `cv.CONDITIONS_SCHEMA`).

### Services

- `zeitwerk.apply` – aktuelles Profil eines Plans sofort anwenden
- `zeitwerk.set_profile_value` – Wert in einem Profil ändern (z. B. Komfort auf 21 °C)
- `zeitwerk.skip_next` – nächsten Wechsel überspringen
- `zeitwerk.force_profile` – Profil für eine Dauer erzwingen (z. B. „2 h Komfort“)

### Zeitsteuerung

- Pro Plan genau ein Timer auf den nächsten Wechsel (`async_track_point_in_time`), danach neu berechnen.
- Zeitzone und Sommer-/Winterzeit über `dt_util`; Tests für die Umstellungstage sind Pflicht.
- Overrides und Aktivierung: State-Listener auf alle in Bedingungen verwendeten Entitäten (`async_track_state_change_event`); bei `activation.reevaluate: false` nur Prüfung zu Blockgrenzen.
- Feiertage: Tageswechsel um 00:00 neu bewerten; Feiertagsquelle wird zusätzlich überwacht (Kalender kann sich ändern).

---

## 5. Karte (zeitwerk-card)

### Ansichten

1. **Wochenraster** (ein Plan): 7 Zeilen (Mo–So) oder Spalten, Blöcke farbig nach Profil.
   - Hauptansicht nur Anzeige: jeder Wochentag eine Zeile, keine Reiter.
   - Tag antippen → Tages-Editor: alle Blöcke des Tages auf einer 24-h-Leiste; Blöcke hinzufügen, löschen, Profil und Zeiten ändern, Ränder/Blöcke ziehen (Touch und Maus), Raster 15 min (konfigurierbar).
   - Blöcke liegen innerhalb eines Tages (0:00–24:00), nichts tagesübergreifend.
   - Speichern mit Auswahl, für welche weiteren Tage dieser Tagesplan gilt (deren Blöcke werden ersetzt).
   - Intern bleiben Tagestypen das Speicherformat; Tage mit identischem Plan werden automatisch zusammengefasst (Name z. B. „Mo–Fr“).
   - (Geändert 2026-11-04 auf Wunsch von Steven: früher Reiter je Tagestyp, Block antippen, „Tag kopieren auf …“.)
2. **Zeitleiste** (mehrere Pläne): heute bzw. 24 h, ein Band pro Plan, „Jetzt“-Linie, nächster Wechsel als Text.
3. **Profil-Editor** (Zahnrad neben „Profile“): 1–5 Profile mit Name, Symbol, Farbe; genau ein Standardprofil. Aktionen entweder „eine Entität für alle“ (je Profil ein Wert) oder „eigene je Profil“ (Zeilen Entität → Wert); sonst HA-Aktionseditor. Profil löschen: seine Blöcke entfallen (dort gilt das Standardprofil), Regeln wechseln aufs Standardprofil. (Ergänzt 2026-11-05.)
   - Häufiger Fall „eine Entität auf einen Wert setzen“ bekommt eine **Schnellansicht**: Entität + passender Regler (Zahl/Temperatur, Auswahl, an/aus, Helligkeit …) aus den HA-Selektoren.
   - Volle Aktionsbearbeitung über `ha-selector` / Aktions-Editor von HA.
4. **Overrides**: Liste mit Priorität (ziehen zum Sortieren), Bedingungen über HA-Bedingungseditor, Umschalter „alle / mindestens eine“, Anzeige „gerade aktiv“.
5. **Aktivierung**: Bedingungen für den ganzen Plan mit „alle / mindestens eine“, Verhalten bei inaktivem Plan, Status im Kopf der Karte (z. B. „pausiert – niemand zu Hause“).
6. **Feiertage**: Auswahl der Quelle (Kalender/Workday), Modus „aus / wie Wochentag … / eigener Tagestyp“; Feiertags-Tagestyp erscheint als eigener Reiter; Vorschau der nächsten Feiertage.

### Kartenkonfiguration

```yaml
type: custom:zeitwerk-card
view: week          # week | timeline | profiles
plan: wohnzimmer_heizung        # bei week/profiles
tags: [heizung]                  # bei timeline
show_profile_sliders: true       # Regler der Profilwerte oben anzeigen
time_step: 15
compact: false
```

### Design

- Nutzt HA-Theme-Variablen (`--primary-color`, `--card-background-color` …), funktioniert in Hell/Dunkel.
- Optik kompatibel zu Bubble Card (abgerundet, ruhige Flächen), aber ohne Abhängigkeit davon.
- Mobil zuerst: große Touch-Ziele, kein Hover-Zwang.
- Visueller Editor (`getConfigElement`) für die Kartenkonfiguration.

### Technik

- TypeScript, Lit 3, Rollup oder Vite, Ausgabe eine ES-Modul-Datei.
- Typen aus `custom-card-helpers` bzw. `home-assistant-js-websocket`.
- Übersetzungen `de` / `en`, Sprache aus `hass.locale`.

---

## 6. Repository-Struktur

```
zeitwerk/
├── custom_components/zeitwerk/...
├── frontend/
│   ├── src/ (zeitwerk-card.ts, views/, components/, localize/)
│   ├── package.json
│   └── rollup.config.mjs
├── tests/                      # pytest (Backend)
├── frontend/tests/             # Vitest (Logik), optional Playwright
├── .github/workflows/
│   ├── validate.yml            # hassfest + HACS-Action + Lint + Tests
│   └── release.yml             # Frontend bauen, in custom_components kopieren, Release-ZIP
├── hacs.json
├── README.md (de + en, Screenshots)
├── CHANGELOG.md
└── LICENSE (MIT)
```

`hacs.json`:

```json
{
  "name": "Zeitwerk",
  "homeassistant": "2026.6.0",
  "render_readme": true,
  "zip_release": true,
  "filename": "zeitwerk.zip"
}
```

---

## 7. Qualität

- Backend-Tests mit `pytest-homeassistant-custom-component`: Profilermittlung, Overrides mit Priorität, Aktivierung mit all/any, Feiertage (beide Modi, Feiertag auf Wochenende), Blöcke über Mitternacht, Neustart, Sommer-/Winterzeit, manuelle Übersteuerung.
- Frontend: Unit-Tests für Zeitrechnung und Blocklogik (Überlappungen, Mitternacht).
- `hassfest` und HACS-Validierung in CI.
- Keine `.storage`-Manipulation von außen; Schema-Version im Store mit Migrationsfunktionen.

---

## 8. Meilensteine

| Version | Inhalt |
|---|---|
| 0.1 | Backend: Pläne, Profile, Wochenblöcke, Ausführung, Neustart; Bearbeitung zunächst über Services; Sensoren/Switch |
| 0.2 | Karte: Wochenraster (antippen, bearbeiten), Profil-Schnellansicht mit Reglern |
| 0.3 | Overrides und Aktivierungs-Bedingungen (all/any) inkl. Editor; manuelle Übersteuerung |
| 0.4 | Feiertage (wie Wochentag / eigener Tagestyp), Zeitleiste, Ziehen per Touch, Tag kopieren |
| 0.5 | Config-Flow, visueller Karteneditor, Übersetzungen |
| 1.0 | Stabil, Doku, Screenshots, Aufnahme in HACS-Standardliste beantragen |

---

## 9. Erster Einsatz: eigene Heizung (Referenzfall)

Bestehende Logik zum Abgleich (aktuell als Automation `claude_Heizplan` umgesetzt):

- Ziele: `input_number.temperaturspeicher_{wohnzimmer,schlafzimmer,bad,kueche,buero}` (die Thermostat-Steuerung liest diese Sollwerte).
- Profile pro Raum: Komfort 22 °C, Absenkung 18 °C, Abwesend 16 °C, Urlaub 16 °C.
- Overrides: `input_boolean.claude_urlaub` (Urlaub) vor „niemand zu Hause“ (`input_boolean.claude_heizung_abgesenkt`, gesetzt vom Geofencing).
- Wochenpläne: Wohnzimmer Mo–Fr 16–22, Sa–So 9–22 Komfort; Bad täglich 6–8 und 18–21 Komfort; übrige Räume ganztägig Absenkung.
- Feiertage: Wohnzimmer Feiertage wie Sonntag (`holidays.mode: like_day`, `like_day: sun`), Quelle Holiday-Integration Hessen.

Migration: Sobald 0.3 läuft, werden die Pläne angelegt, `claude_Heizplan` + Scheduler-Pläne deaktiviert (nicht gelöscht) und beides eine Woche parallel beobachtet.
