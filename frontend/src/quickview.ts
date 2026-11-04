/**
 * Profile quick view: detect the common "one entity -> one value" profile and
 * describe a matching control (slider, select or switch).
 */
import type { HassEntity, Profile, ProfileAction } from "./types";

/** Same order as the backend (manager.VALUE_KEYS). */
export const VALUE_KEYS = [
  "value",
  "temperature",
  "option",
  "brightness_pct",
  "brightness",
  "position",
  "percentage",
] as const;

export type QuickValue =
  | { kind: "value"; entityId: string; key: string; value: unknown }
  | { kind: "toggle"; entityId: string; on: boolean };

export type Control =
  | { type: "number"; min: number; max: number; step: number; unit: string }
  | { type: "select"; options: string[] }
  | { type: "toggle" };

function targets(action: ProfileAction): string[] {
  const ids = action.target?.entity_id ?? action.entity_id ?? [];
  return typeof ids === "string" ? [ids] : [...ids];
}

/** The single value a profile sets, or null when the profile is more complex. */
export function quickValue(profile: Profile | undefined): QuickValue | null {
  if (!profile) return null;
  const actions = profile.actions.filter(
    (a) => a && typeof a === "object" && (a.action || a.service),
  );
  if (actions.length !== 1 || actions.length !== profile.actions.length) return null;
  const action = actions[0];
  const entities = targets(action);
  if (entities.length !== 1) return null;
  const data = action.data ?? {};
  const key = VALUE_KEYS.find((k) => k in data);
  if (key) return { kind: "value", entityId: entities[0], key, value: data[key] };
  const service = String(action.action ?? action.service);
  const extra = Object.keys(data).length > 0;
  if (!extra && /\.turn_(on|off)$/.test(service)) {
    return { kind: "toggle", entityId: entities[0], on: service.endsWith("_on") };
  }
  return null;
}

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Control matching the value key and the target entity's attributes. */
export function controlFor(
  qv: QuickValue,
  entity: HassEntity | undefined,
  temperatureUnit = "°C",
): Control {
  if (qv.kind === "toggle") return { type: "toggle" };
  const a = entity?.attributes ?? {};
  switch (qv.key) {
    case "option":
      return {
        type: "select",
        options: Array.isArray(a.options) ? a.options.map(String) : [String(qv.value)],
      };
    case "temperature":
      return {
        type: "number",
        min: num(a.min_temp, 7),
        max: num(a.max_temp, 35),
        step: num(a.target_temp_step, 0.5),
        unit: temperatureUnit,
      };
    case "brightness":
      return { type: "number", min: 0, max: 255, step: 1, unit: "" };
    case "brightness_pct":
    case "position":
    case "percentage":
      return { type: "number", min: 0, max: 100, step: 1, unit: "%" };
    default:
      return {
        type: "number",
        min: num(a.min, 0),
        max: num(a.max, 100),
        step: num(a.step, 1),
        unit: typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : "",
      };
  }
}

/** Number of decimals implied by a step (0.5 -> 1, 1 -> 0). */
export function stepDecimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Position of a value in [min, max] as a fraction 0..1. */
export function fraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Snap a slider value to the step grid starting at min. */
export function snapValue(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  const clamped = Math.min(max, Math.max(min, snapped));
  return Number(clamped.toFixed(stepDecimals(step)));
}

export function formatValue(
  qv: QuickValue,
  control: Control,
  locale: string,
  onOff: [string, string],
): string {
  if (qv.kind === "toggle") return qv.on ? onOff[0] : onOff[1];
  if (control.type !== "number") return String(qv.value);
  const n = Number(qv.value);
  if (!Number.isFinite(n)) return String(qv.value);
  const decimals = stepDecimals(control.step);
  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
  if (!control.unit) return text;
  return control.unit === "%" ? `${text} %` : `${text} ${control.unit}`;
}

/** Copy of the profile's actions with a toggle switched to turn_on / turn_off. */
export function toggledActions(profile: Profile, on: boolean): ProfileAction[] {
  return profile.actions.map((a) => {
    const key = a.action ? "action" : "service";
    const service = String(a[key] ?? "");
    if (!/\.turn_(on|off)$/.test(service)) return a;
    return { ...a, [key]: service.replace(/turn_(on|off)$/, on ? "turn_on" : "turn_off") };
  });
}
