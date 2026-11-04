/** UI strings (German wording from the mockup is the reference). */

const en = {
  weekdays_short: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
  weekdays_long: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  holiday_short: "Hol",
  holiday: "Holiday",
  holiday_like: "like {day}",
  section_profiles: "Profiles",
  section_week: "Week plan",
  default_suffix: "Default",
  plan_running: "Plan running",
  plan_off: "Plan off",
  plan_paused: "paused",
  plan_error: "Error",
  no_override: "no override active",
  override_active: "{name} active",
  forced_until: "{profile} until {time}",
  from_time: "from {time}",
  now: "Now {time}",
  next_change: "next change {time} → {profile}",
  no_next_change: "no change in the next days",
  hint: "Tap a block to edit · long-press for a new block",
  toggle_plan: "Turn plan on or off",
  edit_block: "Edit {profile} block {time}",
  new_block: "New block",
  block_title: "Edit block",
  profile: "Profile",
  start: "Start",
  end: "End",
  earlier: "{field} {step} min earlier",
  later: "{field} {step} min later",
  duration: "Duration {duration} · outside applies {profile} (default)",
  delete: "Delete",
  cancel: "Cancel",
  save: "Save",
  close: "Close",
  on: "On",
  off: "Off",
  no_plan: "Choose a plan in the card configuration (plan: <id>).",
  plan_missing: 'Plan "{plan}" not found.',
  no_plans: "No Zeitwerk plans yet.",
  not_loaded: "Zeitwerk is not available: {error}",
  loading: "Loading…",
  save_failed: "Saving failed: {error}",
  admin_only: "Only administrators can change the week plan.",
  view_unsupported: 'View "{view}" comes in a later version.',
  day_type_tabs: "Day types",
  no_days: "no days",
};

type Strings = typeof en;

const de: Strings = {
  weekdays_short: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  weekdays_long: ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"],
  holiday_short: "Ft",
  holiday: "Feiertag",
  holiday_like: "wie {day}",
  section_profiles: "Profile",
  section_week: "Wochenplan",
  default_suffix: "Standard",
  plan_running: "Plan läuft",
  plan_off: "Plan aus",
  plan_paused: "pausiert",
  plan_error: "Fehler",
  no_override: "kein Vorrang aktiv",
  override_active: "{name} aktiv",
  forced_until: "{profile} bis {time}",
  from_time: "ab {time}",
  now: "Jetzt {time}",
  next_change: "nächster Wechsel {time} → {profile}",
  no_next_change: "kein Wechsel in den nächsten Tagen",
  hint: "Block antippen zum Bearbeiten · lange drücken für neuen Block",
  toggle_plan: "Plan an oder aus",
  edit_block: "{profile}-Block {time} Uhr bearbeiten",
  new_block: "Neuer Block",
  block_title: "Block bearbeiten",
  profile: "Profil",
  start: "Beginn",
  end: "Ende",
  earlier: "{field} {step} Minuten früher",
  later: "{field} {step} Minuten später",
  duration: "Dauer {duration} · außerhalb gilt {profile} (Standard)",
  delete: "Löschen",
  cancel: "Abbrechen",
  save: "Speichern",
  close: "Schließen",
  on: "An",
  off: "Aus",
  no_plan: "Bitte in der Kartenkonfiguration einen Plan wählen (plan: <id>).",
  plan_missing: "Plan „{plan}“ nicht gefunden.",
  no_plans: "Noch keine Zeitwerk-Pläne vorhanden.",
  not_loaded: "Zeitwerk ist nicht verfügbar: {error}",
  loading: "Lädt …",
  save_failed: "Speichern fehlgeschlagen: {error}",
  admin_only: "Nur Administratoren können den Wochenplan ändern.",
  view_unsupported: "Ansicht „{view}“ kommt in einer späteren Version.",
  day_type_tabs: "Tagestypen",
  no_days: "keine Tage",
};

const LANGUAGES: Record<string, Strings> = { en, de };

export type StringKey = {
  [K in keyof Strings]: Strings[K] extends string ? K : never;
}[keyof Strings];

export interface Localizer {
  lang: string;
  t(key: StringKey, vars?: Record<string, string | number>): string;
  weekdayShort(index: number): string;
  weekdayLong(index: number): string;
}

export function localizer(language: string | undefined): Localizer {
  const lang = (language ?? "en").split("-")[0].toLowerCase();
  const strings = LANGUAGES[lang] ?? en;
  return {
    lang: language ?? "en",
    t(key, vars) {
      let text = strings[key] ?? en[key];
      for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, String(v));
      return text;
    },
    weekdayShort: (i) => strings.weekdays_short[i],
    weekdayLong: (i) => strings.weekdays_long[i],
  };
}

/** "Mo–Fr", "Sa–So", "Mo, Mi, Fr". */
export function daysLabel(indices: number[], l: Localizer): string {
  const sorted = [...indices].sort((a, b) => a - b);
  if (!sorted.length) return l.t("no_days");
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (sorted.length > 2 && contiguous) {
    return `${l.weekdayShort(sorted[0])}–${l.weekdayShort(sorted[sorted.length - 1])}`;
  }
  if (sorted.length === 2 && contiguous) {
    return `${l.weekdayShort(sorted[0])}–${l.weekdayShort(sorted[1])}`;
  }
  return sorted.map((d) => l.weekdayShort(d)).join(", ");
}
