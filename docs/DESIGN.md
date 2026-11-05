# DESIGN.md – zeitwerk-card

Approved mockup: four phone screens (390 px wide) in `docs/mockup/`:

| File | Screen | Card view |
|---|---|---|
| `Main.dc.html` | Week plan of one plan (header, status chips, profile sliders, day-type tabs, week grid with now-line, rules list) | `view: week` |
| `Timeline.dc.html` | Today, all plans as 24 h bands with now-line and next change | `view: timeline` |
| `Editor.dc.html` | Bottom sheet „Block bearbeiten“ (profile picker, start/end steppers in 15 min, live preview bar, copy to other day types, delete/save) | dialog of `week` |
| `Regeln.dc.html` | Overrides (drag to sort), activation (all/any), holidays (source, mode, next holidays) | sub-page / dialog of `week` |

The `.dc.html` files were made in a design tool: they use a small template runtime (`<x-dc>`, `<sc-for>`, `{{holes}}`, `class Component extends DCLogic`). **Use them as markup/style reference only** – they will not render standalone and none of that syntax belongs in the card. The inline styles contain the exact sizes, colours and spacing.

Steven's live dashboard uses Bubble Card with his own dark monochrome theme „Claude Glass“ (`docs/reference/claude_glass_theme.yaml`). The card must look at home there **and** in the default HA light/dark themes.

---

## 1. Tokens

Always read from HA theme variables first, mockup value as fallback. Define them once on `:host`.

| Token (card CSS var) | Source variable(s) | Mockup fallback |
|---|---|---|
| `--zw-bg` | `--ha-card-background`, `--card-background-color` | `#151518` |
| `--zw-surface` (pills, tracks) | `--secondary-background-color` mixed / `rgba(255,255,255,.06)` | `rgba(255,255,255,0.06)` |
| `--zw-border` | `--ha-card-border-color`, `--divider-color` | `rgba(255,255,255,0.08–0.12)` |
| `--zw-text` | `--primary-text-color` | `#f5f5f7` |
| `--zw-text-2` | `--secondary-text-color` | `rgba(245,245,247,0.62)` |
| `--zw-accent` (selected tab, switch, primary button) | `--primary-text-color` on dark themes (monochrome), `--primary-color` otherwise | `#f5f5f7` |
| `--zw-ok` | `--success-color` | `#4ad295` |
| `--zw-danger` | `--error-color` | `#ff5a6e` |
| `--zw-radius-card` | `--ha-card-border-radius` | `26px` |
| `--zw-radius-pill` | – | `height / 2` |
| font | `--ha-font-family-body` / inherit | (mockup used Figtree = HA default) |

Profile colours come from the plan data (`profile.color`). Defaults for new profiles: Komfort `#ff8b4a`, Absenkung `#6fa8ff`, Abwesend `#aeaeb8`; further profiles cycle through a small palette with similar lightness. Text on a filled profile colour is near-black (`#1b0f07` style), check 4.5:1 contrast.

Default profile (the one valid outside all blocks) is drawn as the **track background** at ~16 % opacity of its colour; blocks of other profiles are solid. Manual override: diagonal hatch (`repeating-linear-gradient(135deg, …)`).

## 2. Components (sizes from the mockup)

- **Header**: 64 px pill (radius 32), 44 px icon circle tinted with the active profile colour, name 15/600, subline 13 px „<Profil> <Wert> · ab HH:MM → <nächster Wert>“, plan on/off switch on the right.
- **Status** (changed 0.8.1 on Steven's request, replaces the status chips): no chip row. Plan off / paused / error stay in the header subline; a third header line (12 px, icon 14 px, profile colour) appears only when the plan deviates from the week plan: „Vorrang: <name>“, „manuell bis HH:MM“, forced „<Profil> bis HH:MM“, „Feiertag“. Today's grid row: 1.5 px outline (text colour 60 %).
- **Separator**: title 15/600 + 1 px line (Bubble separator look).
- **Profile slider** (`show_profile_sliders`): 48 px pill, fill = value position in the entity's min/max at 30 % profile colour with a 2 px solid edge, 36 px icon circle in profile colour, name + value right. Only for the "quick view" case (one entity → one value); drag/tap changes the profile value via `zeitwerk.set_profile_value` (debounced, ~400 ms).
- **Day-type tabs**: removed (2026-11-04). Every weekday is its own row; with `holidays.mode = own_day_type` a „Ft“ row follows Sunday.
- **Week grid**: card padding 14, hour axis (0/6/12/18/24, 11 px), 7 rows: 26 px day label (today bold) + 30 px track radius 10; all rows full opacity, each row is a button opening the day editor; blocks show „16–22“ at 11/700. Now-line: 2 px vertical line across all tracks + 10 px dot on top; caption „Jetzt HH:MM · nächster Wechsel …“. Legend below.
- **Interaction**: the main grid is read-only; tap a day → day editor (in-card page): 56 px bar with all blocks of the day, tap block = select, tap empty spot or „+ Block“ = add, drag handles (44 px hit area) or the block (snap `time_step`, live time tooltip, stops at neighbours and 0:00/24:00); selected block panel with profile picker, steppers, „Block löschen“; day chips Mo–So (+Ft) with Mo–Fr / Sa–So / Alle to save the plan for more days (replaces their blocks); unsaved changes need „Verwerfen“.
- **Timeline**: one card per plan (radius 26), 36 px icon, name, current profile + value, right side „ab HH:MM / Wert“ or „in 20 min“, 16 px band below with now-line. Active (non-default) plan gets a 1 px border in the profile colour.
- **Editor sheet** (superseded by the day editor, kept for reference): `ha-dialog` or own bottom sheet (radius 28 top), grabber, title + context, profile picker (3-up buttons 64 px, selected = 2 px border in profile colour), Beginn/Ende steppers (52 px pill, 44 px ± buttons), preview bar 36 px with handles, „Auch übernehmen für“ chips, Löschen (outline danger) + Speichern (filled accent, 2:1 width).
- **Configuration page** (0.8.2, formerly „Regeln“; sections „Regeln“ with „?“ help and „Plan“ with edit/delete and duplicate): override rows 64 px with drag handle, profile icon, „<Name> → <Profil>“, condition summary, state badge (aktiv / inaktiv); dashed „+ Vorrang-Regel“; activation card with all/any segmented control and condition rows with live ✓ state; holiday card with source picker, mode segmented control, next three holidays. The full condition editing uses HA's own condition editor (`ha-selector` with `condition: {}` selector) inside a dialog.

Language of all UI strings: from `hass.locale.language`, `de` and `en` shipped. German strings in the mockup are the reference wording.

## 3. Performance rules

- Render only when something relevant changed: implement `shouldUpdate` and compare only the `hass.states` objects of the plan's own sensors (`sensor.zeitwerk_<plan>_*`, `switch.zeitwerk_<plan>`) plus the quick-view entities – not every `hass` update.
- Plan data comes from `zeitwerk/plans/subscribe` (one subscription per card, unsubscribed in `disconnectedCallback`).
- Now-line: one shared `setInterval` per card aligned to the full minute, updating a single CSS custom property (`--zw-now: 73.6%`) – no full re-render.
- Blocks positioned with percentages (`left`, `width`) – no layout measuring in JS except during drag.
- No `backdrop-filter`, no box-shadow animations, no web fonts loaded by the card, no images.
- Editor sheet and rules page code paths are rendered only when opened.
- Measure and record the gzip bundle size in the README; keep it small (target well under 100 KB gz) – no big dependencies.
- `getCardSize()` / `getGridOptions()` implemented so sections dashboards lay it out correctly; `compact: true` hides profile sliders and rules list and shrinks the grid to 22 px tracks.

## 4. Accessibility

- Real `<button>`s with `aria-label` for icon-only buttons, tabs with `role="tab"` / `aria-selected`, keyboard: arrow keys move/resize a focused block by `time_step`, Enter opens the editor, Delete removes (with confirmation).
- Colour is never the only signal: blocks carry their time label, profiles their name.
