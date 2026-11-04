/** Plan creation wizard: build a complete plan from a few answers. */
import { uniqueId } from "./conditions";
import { PALETTE } from "./colors";
import type { HassEntity, ProfileAction, Weekday } from "./types";

export type TargetKind =
  | {
      kind: "number";
      service: string;
      key: string;
      min: number;
      max: number;
      step: number;
      unit: string;
    }
  | { kind: "select"; service: string; key: string; options: string[] }
  | { kind: "toggle"; domain: string };

export interface WizardProfile {
  name: string;
  color: string;
  icon: string;
  value: number | string | boolean;
}

export interface WizardDraft {
  name: string;
  id?: string;
  icon: string;
  tags: string[];
  entityId: string;
  profiles: WizardProfile[];
  defaultIndex: number;
  layout: "week" | "daily";
}

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Which action sets a value on this entity, and how the value looks. */
export function targetKind(
  entityId: string,
  entity?: HassEntity,
  temperatureUnit = "°C",
): TargetKind {
  const domain = entityId.split(".")[0];
  const a = entity?.attributes ?? {};
  switch (domain) {
    case "input_number":
    case "number":
      return {
        kind: "number",
        service: `${domain}.set_value`,
        key: "value",
        min: num(a.min, 0),
        max: num(a.max, 100),
        step: num(a.step, 1),
        unit: typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : "",
      };
    case "climate":
      return {
        kind: "number",
        service: "climate.set_temperature",
        key: "temperature",
        min: num(a.min_temp, 7),
        max: num(a.max_temp, 35),
        step: num(a.target_temp_step, 0.5),
        unit: temperatureUnit,
      };
    case "input_select":
    case "select":
      return {
        kind: "select",
        service: `${domain}.select_option`,
        key: "option",
        options: Array.isArray(a.options) ? a.options.map(String) : [],
      };
    case "light":
      return {
        kind: "number",
        service: "light.turn_on",
        key: "brightness_pct",
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      };
    case "cover":
      return {
        kind: "number",
        service: "cover.set_cover_position",
        key: "position",
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      };
    case "fan":
      return {
        kind: "number",
        service: "fan.set_percentage",
        key: "percentage",
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      };
    default:
      return { kind: "toggle", domain };
  }
}

const TOGGLE_DOMAINS = new Set([
  "switch",
  "input_boolean",
  "light",
  "fan",
  "automation",
  "script",
  "siren",
  "humidifier",
  "climate",
  "media_player",
]);

/** Three starting profiles (Komfort / Absenkung / Abwesend style). */
export function defaultProfiles(
  target: TargetKind,
  names: [string, string, string],
): WizardProfile[] {
  const icons = ["mdi:sun-thermometer-outline", "mdi:weather-night", "mdi:home-export-outline"];
  let values: (number | string | boolean)[];
  if (target.kind === "number") {
    const isTemp = target.key === "temperature" || target.unit.includes("°");
    values = isTemp
      ? [22, 18, 16].map((v) => Math.min(target.max, Math.max(target.min, v)))
      : [target.max, Math.round((target.min + target.max) / 2), target.min];
  } else if (target.kind === "select") {
    const o = target.options;
    values = [o[0] ?? "", o[1] ?? o[0] ?? "", o[2] ?? o[0] ?? ""];
  } else {
    values = [true, false, false];
  }
  return names.map((name, i) => ({ name, color: PALETTE[i], icon: icons[i], value: values[i] }));
}

export function profileActions(
  entityId: string,
  target: TargetKind,
  value: WizardProfile["value"],
): ProfileAction[] {
  const t = { entity_id: entityId };
  if (target.kind === "toggle") {
    const domain = TOGGLE_DOMAINS.has(target.domain) ? target.domain : "homeassistant";
    return [{ action: `${domain}.${value ? "turn_on" : "turn_off"}`, target: t }];
  }
  return [{ action: target.service, target: t, data: { [target.key]: value } }];
}

const WORKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND: Weekday[] = ["sat", "sun"];

/** Complete plan dict for `zeitwerk/plans/create`. */
export function buildPlan(
  draft: WizardDraft,
  target: TargetKind,
  labels: { workday: string; weekend: string; daily: string },
): Record<string, unknown> {
  const ids: string[] = [];
  const profiles = draft.profiles.map((p) => {
    const id = uniqueId(p.name, ids);
    ids.push(id);
    return {
      id,
      name: p.name.trim(),
      color: p.color,
      icon: p.icon || null,
      actions: profileActions(draft.entityId, target, p.value),
    };
  });
  const defaultIndex = Math.min(Math.max(0, draft.defaultIndex), profiles.length - 1);
  const defaultId = profiles[defaultIndex].id;
  const main = profiles.find((p) => p.id !== defaultId)?.id;
  const block = (start: string, end: string) => (main ? [{ start, end, profile: main }] : []);
  const dayTypes =
    draft.layout === "daily"
      ? [
          {
            id: "daily",
            name: labels.daily,
            days: [...WORKDAYS, ...WEEKEND],
            blocks: block("06:00", "22:00"),
          },
        ]
      : [
          {
            id: "workday",
            name: labels.workday,
            days: WORKDAYS,
            blocks: main
              ? [
                  { start: "06:00", end: "08:00", profile: main },
                  { start: "16:00", end: "22:00", profile: main },
                ]
              : [],
          },
          { id: "weekend", name: labels.weekend, days: WEEKEND, blocks: block("08:00", "22:00") },
        ];
  const plan: Record<string, unknown> = {
    name: draft.name.trim(),
    icon: draft.icon || null,
    tags: draft.tags.map((t) => t.trim()).filter(Boolean),
    profiles,
    default_profile: defaultId,
    week: { day_types: dayTypes },
  };
  if (draft.id?.trim()) plan.id = draft.id.trim();
  return plan;
}

/** Problems that block creating the plan (keys into the localizer). */
export function draftErrors(
  draft: WizardDraft,
): ("name_required" | "entity_required" | "profiles_required")[] {
  const errors: ("name_required" | "entity_required" | "profiles_required")[] = [];
  if (!draft.name.trim()) errors.push("name_required");
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(draft.entityId)) errors.push("entity_required");
  if (draft.profiles.length < 2 || draft.profiles.some((p) => !p.name.trim()))
    errors.push("profiles_required");
  return errors;
}
