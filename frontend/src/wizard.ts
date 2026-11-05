/** Plan creation wizard: build a complete plan from a few answers. */
import { PALETTE } from "./colors";
import type { HassEntity, Profile, Weekday } from "./types";

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

/** Plan basics of the wizard; profiles come from the embedded profiles editor. */
export interface WizardDraft {
  name: string;
  id?: string;
  icon: string;
  tags: string[];
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

/** Starting profiles (Komfort / Absenkung / Abwesend style), nothing switched yet. */
export function seedProfiles(names: [string, string, string]): Profile[] {
  const icons = ["mdi:sun-thermometer-outline", "mdi:weather-night", "mdi:home-export-outline"];
  const ids = ["comfort", "eco", "away"];
  return names.map((name, i) => ({
    id: ids[i],
    name,
    color: PALETTE[i],
    icon: icons[i],
    actions: [],
  }));
}

const WORKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND: Weekday[] = ["sat", "sun"];

/** Complete plan dict for `zeitwerk/plans/create`. */
export function buildPlan(
  draft: WizardDraft,
  profiles: Profile[],
  defaultId: string,
  labels: { workday: string; weekend: string; daily: string },
): Record<string, unknown> {
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
            blocks: [...block("06:00", "08:00"), ...block("16:00", "22:00")],
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

/** Problems with the plan basics (keys into the localizer). */
export function draftErrors(draft: WizardDraft): "name_required"[] {
  return draft.name.trim() ? [] : ["name_required"];
}
