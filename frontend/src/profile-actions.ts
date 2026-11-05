/**
 * Profile editor logic: a profile's actions as simple "entity -> value" rows,
 * the shared-entity mode, and removing profiles (fallback to the default).
 */
import { uniqueId } from "./conditions";
import { PALETTE } from "./colors";
import { VALUE_KEYS } from "./quickview";
import { targetKind, type TargetKind } from "./wizard";
import type { HassEntity, Plan, Profile, ProfileAction } from "./types";

export const MAX_PROFILES = 5;
export const WHEN_INACTIVE_PREFIX = "profile:";

/** One "entity -> value" line of a profile. */
export interface ActionRow {
  entityId: string;
  /** Switches and lights: on/off. */
  on: boolean;
  /** Number or option; lights: brightness in % (null = just switch on). */
  value: number | string | null;
}

/** How a row's value is edited. */
export type RowKind =
  | { kind: "light" }
  | { kind: "toggle"; domain: string }
  | Extract<TargetKind, { kind: "number" | "select" }>;

const TOGGLE_SERVICE_DOMAINS = new Set([
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
  "scene",
]);

export function rowKind(entityId: string, entity?: HassEntity, temperatureUnit = "°C"): RowKind {
  if (entityId.startsWith("light.")) return { kind: "light" };
  const target = targetKind(entityId, entity, temperatureUnit);
  return target.kind === "toggle" ? { kind: "toggle", domain: target.domain } : target;
}

function targets(action: ProfileAction): string[] {
  const ids = action.target?.entity_id ?? action.entity_id ?? [];
  return typeof ids === "string" ? [ids] : [...ids];
}

/** A single action as a row, or null when it is more than "entity -> value". */
export function parseAction(action: ProfileAction): ActionRow | null {
  if (!action || typeof action !== "object") return null;
  const service = String(action.action ?? action.service ?? "");
  if (!/^[a-z_]+\.[a-z_]+$/.test(service)) return null;
  const known = new Set(["action", "service", "target", "entity_id", "data"]);
  if (Object.keys(action).some((k) => !known.has(k))) return null;
  const entities = targets(action);
  if (entities.length !== 1) return null;
  const entityId = entities[0];
  const data = action.data ?? {};
  const keys = Object.keys(data);
  if (/\.turn_(on|off)$/.test(service)) {
    const on = service.endsWith("_on");
    if (keys.length === 0) return { entityId, on, value: null };
    if (on && entityId.startsWith("light.") && keys.length === 1 && "brightness_pct" in data) {
      return { entityId, on: true, value: Number(data.brightness_pct) };
    }
    if (on && keys.length === 1 && VALUE_KEYS.includes(keys[0] as never)) {
      return { entityId, on: true, value: data[keys[0]] as number | string };
    }
    return null;
  }
  if (keys.length === 1 && VALUE_KEYS.includes(keys[0] as never)) {
    return { entityId, on: true, value: data[keys[0]] as number | string };
  }
  return null;
}

/** All actions of a profile as rows, or null when one of them is complex. */
export function parseProfile(profile: Pick<Profile, "actions">): ActionRow[] | null {
  const rows: ActionRow[] = [];
  for (const action of profile.actions) {
    const row = parseAction(action);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/** The action for one row. */
export function buildAction(row: ActionRow, kind: RowKind = rowKind(row.entityId)): ProfileAction {
  const target = { entity_id: row.entityId };
  switch (kind.kind) {
    case "light":
      if (!row.on) return { action: "light.turn_off", target };
      return row.value === null || row.value === ""
        ? { action: "light.turn_on", target }
        : { action: "light.turn_on", target, data: { brightness_pct: Number(row.value) } };
    case "toggle": {
      const domain = TOGGLE_SERVICE_DOMAINS.has(kind.domain) ? kind.domain : "homeassistant";
      if (domain === "scene") return { action: "scene.turn_on", target };
      return { action: `${domain}.${row.on ? "turn_on" : "turn_off"}`, target };
    }
    default:
      return { action: kind.service, target, data: { [kind.key]: row.value } };
  }
}

/** A sensible first value for a new row on this entity. */
export function defaultRow(entityId: string, kind: RowKind, index = 0): ActionRow {
  switch (kind.kind) {
    case "light":
      return { entityId, on: index === 0, value: null };
    case "toggle":
      return { entityId, on: index === 0, value: null };
    case "select":
      return { entityId, on: true, value: kind.options[index] ?? kind.options[0] ?? "" };
    default: {
      const isTemp = kind.key === "temperature" || kind.unit.includes("°");
      const raw = isTemp ? [22, 18, 16, 20, 19][index % 5] : kind.max;
      return { entityId, on: true, value: Math.min(kind.max, Math.max(kind.min, raw)) };
    }
  }
}

/** Keep a row's value when it still fits the (new) entity, else use a default. */
export function adaptRow(row: ActionRow, entityId: string, kind: RowKind, index = 0): ActionRow {
  const fresh = defaultRow(entityId, kind, index);
  switch (kind.kind) {
    case "light":
    case "toggle":
      return { entityId, on: row.on, value: kind.kind === "light" ? row.value : null };
    case "select":
      return typeof row.value === "string" && kind.options.includes(row.value)
        ? { ...fresh, value: row.value }
        : fresh;
    default: {
      const n = Number(row.value);
      if (row.value === null || !Number.isFinite(n)) return fresh;
      return { ...fresh, value: Math.min(kind.max, Math.max(kind.min, n)) };
    }
  }
}

/** The entity every profile controls (exactly one row each), else null. */
export function sharedEntity(profiles: Pick<Profile, "actions">[]): string | null {
  let entity: string | null = null;
  for (const p of profiles) {
    const rows = parseProfile(p);
    if (!rows || rows.length !== 1) return null;
    if (entity !== null && rows[0].entityId !== entity) return null;
    entity = rows[0].entityId;
  }
  return entity;
}

/** Next unused palette colour. */
export function nextColor(profiles: Pick<Profile, "color">[]): string {
  const used = new Set(profiles.map((p) => p.color?.toLowerCase()));
  return (
    PALETTE.find((c) => !used.has(c.toLowerCase())) ?? PALETTE[profiles.length % PALETTE.length]
  );
}

/** Ids for profiles that do not have one yet (derived from the name). */
export function assignIds<T extends { id: string; name: string }>(profiles: T[]): T[] {
  const taken = profiles.map((p) => p.id).filter(Boolean);
  return profiles.map((p) => {
    if (p.id) return p;
    const id = uniqueId(p.name || "profile", taken);
    taken.push(id);
    return { ...p, id };
  });
}

/**
 * Point references to removed profiles at the default profile (in place):
 * their blocks are dropped (the default fills gaps), rules switch over.
 * Mirrors schema.replace_missing_profiles in the backend.
 */
export function replaceMissingProfiles(plan: Plan): Plan {
  const ids = new Set(plan.profiles.map((p) => p.id));
  const def = plan.default_profile;
  if (!ids.has(def)) return plan;
  for (const dayType of plan.week.day_types) {
    dayType.blocks = dayType.blocks.filter((b) => ids.has(b.profile));
  }
  for (const o of plan.overrides) {
    if (!ids.has(o.profile)) o.profile = def;
  }
  const when = plan.activation.when_inactive;
  if (when.startsWith(WHEN_INACTIVE_PREFIX) && !ids.has(when.slice(WHEN_INACTIVE_PREFIX.length))) {
    plan.activation.when_inactive = `${WHEN_INACTIVE_PREFIX}${def}`;
  }
  return plan;
}

/** Where a profile is used (for the delete confirmation). */
export function profileUsage(plan: Plan, profileId: string): { blocks: number; rules: number } {
  const blocks = plan.week.day_types.reduce(
    (n, d) => n + d.blocks.filter((b) => b.profile === profileId).length,
    0,
  );
  const rules =
    plan.overrides.filter((o) => o.profile === profileId).length +
    (plan.activation.when_inactive === `${WHEN_INACTIVE_PREFIX}${profileId}` ? 1 : 0);
  return { blocks, rules };
}
