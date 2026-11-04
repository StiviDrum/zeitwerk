/** Short human-readable summaries of HA condition configs (rules page, header). */
import type { Localizer } from "./localize";
import type { HomeAssistant } from "./types";

export type Condition = Record<string, unknown>;

function ids(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function entityName(hass: HomeAssistant | undefined, entityId: string): string {
  const name = hass?.states[entityId]?.attributes.friendly_name;
  return typeof name === "string" && name ? name : entityId;
}

function formatState(hass: HomeAssistant | undefined, entityId: string, state: string): string {
  const entity = hass?.states[entityId];
  if (entity && hass?.formatEntityState) {
    try {
      return hass.formatEntityState(entity, state);
    } catch {
      // fall through
    }
  }
  return state;
}

/** One condition as text, e.g. "Urlaub ist An", "Außentemperatur < 15". */
export function conditionSummary(
  cond: Condition,
  hass: HomeAssistant | undefined,
  l: Localizer,
): string {
  if (typeof cond.alias === "string" && cond.alias) return cond.alias;
  const type = String(cond.condition ?? "");
  const entities = ids(cond.entity_id);
  const names = entities.map((e) => entityName(hass, e)).join(", ");
  switch (type) {
    case "state": {
      const states = ids(cond.state);
      const text = states.map((s) => formatState(hass, entities[0] ?? "", s)).join(" / ");
      const attr = typeof cond.attribute === "string" ? ` (${cond.attribute})` : "";
      return l.t("cond_state", { name: names + attr, state: text });
    }
    case "numeric_state": {
      const parts: string[] = [];
      if (cond.above !== undefined) parts.push(`> ${String(cond.above)}`);
      if (cond.below !== undefined) parts.push(`< ${String(cond.below)}`);
      return `${names} ${parts.join(" ")}`.trim();
    }
    case "time": {
      const after = typeof cond.after === "string" ? cond.after.slice(0, 5) : "";
      const before = typeof cond.before === "string" ? cond.before.slice(0, 5) : "";
      return l.t("cond_time", { from: after || "0:00", to: before || "24:00" });
    }
    case "zone":
      return l.t("cond_zone", { name: names, zone: entityName(hass, String(cond.zone ?? "")) });
    case "template":
      return l.t("cond_template");
    case "and":
    case "or":
    case "not": {
      const inner = Array.isArray(cond.conditions) ? cond.conditions.length : 0;
      return l.t(`cond_${type}` as "cond_and", { count: inner });
    }
    default:
      return names ? `${type}: ${names}` : type || "?";
  }
}

/** "alle: A · B" / "eine: A · B" / single condition without prefix. */
export function conditionsSummary(
  conditions: Condition[],
  match: "all" | "any",
  hass: HomeAssistant | undefined,
  l: Localizer,
): string {
  if (!conditions.length) return l.t("no_conditions");
  const parts = conditions.map((c) => conditionSummary(c, hass, l)).join(" · ");
  if (conditions.length === 1) return parts;
  return `${l.t(match === "any" ? "match_any" : "match_all")}: ${parts}`;
}

/**
 * Reason shown in the header while a plan is paused: the current state of the
 * first failing condition's entity ("Heizperiode: Aus").
 */
export function pauseReason(
  conditions: Condition[],
  results: boolean[],
  hass: HomeAssistant | undefined,
  l: Localizer,
): string {
  const index = results.findIndex((r) => !r);
  const cond = conditions[index];
  if (!cond) return "";
  const entity = ids(cond.entity_id)[0];
  if (entity && hass?.states[entity]) {
    return `${entityName(hass, entity)}: ${formatState(hass, entity, hass.states[entity].state)}`;
  }
  return conditionSummary(cond, hass, l);
}

/** Slug id for a new override, unique within `taken`. */
export function uniqueId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "rule";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
}

/** Move an item from one index to another (drag to sort). */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}
