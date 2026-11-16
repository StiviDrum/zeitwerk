/** Room logic for the panel (SPEC §10): floor grouping, window state, hints, suggestions, payloads. Pure functions. */
import type { Localizer } from "./localize";
import type { HomeAssistant, Plan, Room } from "./types";

export const DEFAULT_ROOM_ICON = "mdi:door";
export const WINDOW_DEVICE_CLASSES = ["window", "door", "opening", "garage_door"];

// --- Floors ---------------------------------------------------------------------

export interface FloorGroup {
  /** Null = rooms without a (known) floor. */
  floorId: string | null;
  name: string;
  icon: string | null;
  rooms: Room[];
}

/** Floor of a room via its area (null: no area, area gone, or area without known floor). */
export function floorOf(room: Room, hass: HomeAssistant | undefined): string | null {
  const area = room.area_id ? hass?.areas?.[room.area_id] : undefined;
  const floor = area?.floor_id;
  return floor && hass?.floors?.[floor] ? floor : null;
}

/**
 * Rooms grouped by HA floor. Floors are ordered like HA (level ascending,
 * floors without level last, then name); rooms without floor come last in
 * "other". Rooms keep the given order within a group (sorted by name).
 */
export function floorGroups(
  rooms: Room[],
  hass: HomeAssistant | undefined,
  otherName: string,
): FloorGroup[] {
  const byFloor = new Map<string | null, Room[]>();
  for (const room of [...rooms].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = floorOf(room, hass);
    byFloor.set(key, [...(byFloor.get(key) ?? []), room]);
  }
  const floors = [...byFloor.keys()]
    .filter((k): k is string => k !== null)
    .map((id) => hass!.floors![id])
    .sort((a, b) => {
      const la = a.level ?? Number.POSITIVE_INFINITY;
      const lb = b.level ?? Number.POSITIVE_INFINITY;
      return la === lb ? a.name.localeCompare(b.name) : la < lb ? -1 : 1;
    });
  const groups: FloorGroup[] = floors.map((f) => ({
    floorId: f.floor_id,
    name: f.name,
    icon: f.icon ?? null,
    rooms: byFloor.get(f.floor_id) ?? [],
  }));
  const other = byFloor.get(null);
  if (other?.length) groups.push({ floorId: null, name: otherName, icon: null, rooms: other });
  return groups;
}

// --- Tile data ------------------------------------------------------------------

export function roomIcon(room: Room, hass: HomeAssistant | undefined): string {
  const area = room.area_id ? hass?.areas?.[room.area_id] : undefined;
  return room.icon || area?.icon || DEFAULT_ROOM_ICON;
}

export type WindowKind = "open" | "closed" | "none";

export interface WindowView {
  kind: WindowKind;
  /** At least one contact is unavailable/unknown. */
  problem: boolean;
}

/** Window symbol of a tile: no contacts -> none; open/closed; problem flag for unavailable contacts. */
export function windowView(room: Room): WindowView {
  if (!room.windows.entities.length) return { kind: "none", problem: false };
  const problem = (room.window?.unavailable.length ?? 0) > 0;
  return { kind: room.window?.open ? "open" : "closed", problem };
}

function formatSensor(hass: HomeAssistant | undefined, entityId: string | null): string {
  const entity = entityId ? hass?.states[entityId] : undefined;
  if (!entity || entity.state === "unavailable" || entity.state === "unknown") return "";
  const formatted = hass?.formatEntityState?.(entity);
  if (formatted) return formatted;
  const unit = entity.attributes?.unit_of_measurement;
  return `${entity.state}${typeof unit === "string" ? ` ${unit}` : ""}`;
}

/** Display strings of the tile ("21.5 °C", "48 %"); empty when no sensor / no value. */
export function roomClimate(
  room: Room,
  hass: HomeAssistant | undefined,
): { temperature: string; humidity: string } {
  return {
    temperature: formatSensor(hass, room.sensors.temperature),
    humidity: formatSensor(hass, room.sensors.humidity),
  };
}

// --- Hints ----------------------------------------------------------------------

export type Hint =
  | { kind: "plan_room_missing"; plan: string; planName: string; room: string }
  | { kind: "area_missing"; room: string; roomName: string }
  | { kind: "window_unavailable"; room: string; roomName: string; entities: string[] };

export function roomHints(rooms: Room[], plans: Plan[]): Hint[] {
  const hints: Hint[] = [];
  for (const plan of plans) {
    if (plan.room_missing && plan.room) {
      hints.push({
        kind: "plan_room_missing",
        plan: plan.id,
        planName: plan.name,
        room: plan.room,
      });
    }
  }
  for (const room of rooms) {
    if (room.area_missing) hints.push({ kind: "area_missing", room: room.id, roomName: room.name });
    const unavailable = room.window?.unavailable ?? [];
    if (unavailable.length) {
      hints.push({
        kind: "window_unavailable",
        room: room.id,
        roomName: room.name,
        entities: unavailable,
      });
    }
  }
  return hints;
}

export function hintText(hint: Hint, l: Localizer): string {
  switch (hint.kind) {
    case "plan_room_missing":
      return l.t("hint_plan_room_missing", { plan: hint.planName, room: hint.room });
    case "area_missing":
      return l.t("hint_area_missing", { room: hint.roomName });
    case "window_unavailable":
      return l.t("hint_window_unavailable", {
        room: hint.roomName,
        entities: hint.entities.join(", "),
      });
  }
}

// --- Suggestions ----------------------------------------------------------------

/** Area of an entity: its own area, otherwise the area of its device. */
export function entityArea(hass: HomeAssistant | undefined, entityId: string): string | null {
  const reg = hass?.entities?.[entityId];
  if (!reg) return null;
  if (reg.area_id) return reg.area_id;
  const device = reg.device_id ? hass?.devices?.[reg.device_id] : undefined;
  return device?.area_id ?? null;
}

function inArea(hass: HomeAssistant, areaId: string, domain: string, classes: string[]): string[] {
  return Object.values(hass.states)
    .filter((e) => e.entity_id.startsWith(`${domain}.`))
    .filter((e) => classes.includes(String(e.attributes?.device_class ?? "")))
    .filter((e) => entityArea(hass, e.entity_id) === areaId)
    .map((e) => e.entity_id)
    .sort();
}

export interface RoomSuggestions {
  windows: string[];
  temperature: string[];
  humidity: string[];
  /** The area's own temperature/humidity entity (HA area setting), if any. */
  areaTemperature: string | null;
  areaHumidity: string | null;
}

/** Window contacts and climate sensors that live in an area. */
export function suggestions(
  hass: HomeAssistant | undefined,
  areaId: string | null,
): RoomSuggestions {
  const empty: RoomSuggestions = {
    windows: [],
    temperature: [],
    humidity: [],
    areaTemperature: null,
    areaHumidity: null,
  };
  if (!hass || !areaId) return empty;
  const area = hass.areas?.[areaId];
  return {
    windows: inArea(hass, areaId, "binary_sensor", WINDOW_DEVICE_CLASSES),
    temperature: inArea(hass, areaId, "sensor", ["temperature"]),
    humidity: inArea(hass, areaId, "sensor", ["humidity"]),
    areaTemperature: area?.temperature_entity_id ?? null,
    areaHumidity: area?.humidity_entity_id ?? null,
  };
}

// --- Room editor draft ----------------------------------------------------------

export interface RoomDraft {
  id?: string;
  name: string;
  nameTouched: boolean;
  area_id: string;
  icon: string;
  windows: string[];
  open_delay: number;
  close_delay: number;
  temperature: string;
  humidity: string;
  /** Values filled in from the area (replaced again when the area changes, unless edited). */
  auto: { temperature: string; humidity: string; windows: string[] };
}

export const DELAY_PRESETS = [0, 30, 60, 120, 300, 600];

export function emptyDraft(): RoomDraft {
  return {
    name: "",
    nameTouched: false,
    area_id: "",
    icon: "",
    windows: [],
    open_delay: 60,
    close_delay: 0,
    temperature: "",
    humidity: "",
    auto: { temperature: "", humidity: "", windows: [] },
  };
}

export function draftFromRoom(room: Room): RoomDraft {
  return {
    id: room.id,
    name: room.name,
    nameTouched: true,
    area_id: room.area_id ?? "",
    icon: room.icon ?? "",
    windows: [...room.windows.entities],
    open_delay: room.windows.open_delay,
    close_delay: room.windows.close_delay,
    temperature: room.sensors.temperature ?? "",
    humidity: room.sensors.humidity ?? "",
    auto: { temperature: "", humidity: "", windows: [] },
  };
}

/**
 * Picking an area: the name follows the area name until edited by hand;
 * empty sensor fields are prefilled from the area's own temperature/humidity
 * entities, and an empty window list from the suggested window contacts only
 * when `fillWindows` (new rooms).
 */
export function applyArea(
  draft: RoomDraft,
  areaId: string,
  hass: HomeAssistant | undefined,
  fillWindows = false,
): RoomDraft {
  const next: RoomDraft = { ...draft, area_id: areaId, auto: { ...draft.auto } };
  const area = areaId ? hass?.areas?.[areaId] : undefined;
  if (!draft.nameTouched && area) next.name = area.name;
  const sug = suggestions(hass, areaId || null);
  // Replace empty fields and values that were auto-filled earlier; keep hand-set ones.
  const temperature = sug.areaTemperature ?? sug.temperature[0] ?? "";
  if (!next.temperature || next.temperature === draft.auto.temperature) {
    next.temperature = temperature;
    next.auto.temperature = temperature;
  }
  const humidity = sug.areaHumidity ?? sug.humidity[0] ?? "";
  if (!next.humidity || next.humidity === draft.auto.humidity) {
    next.humidity = humidity;
    next.auto.humidity = humidity;
  }
  if (fillWindows) {
    const same =
      next.windows.length === draft.auto.windows.length &&
      next.windows.every((w, i) => w === draft.auto.windows[i]);
    if (!next.windows.length || same) {
      next.windows = sug.windows;
      next.auto.windows = [...sug.windows];
    }
  }
  return next;
}

/** Problems with a draft (localizer keys). */
export function draftErrors(draft: RoomDraft): "name_required"[] {
  return draft.name.trim() ? [] : ["name_required"];
}

/** Payload for `zeitwerk/rooms/create|update` (`id` only for existing rooms; the backend derives new ids). */
export function roomPayload(draft: RoomDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
    area_id: draft.area_id || null,
    icon: draft.icon.trim() || null,
    windows: {
      entities: [...new Set(draft.windows.filter(Boolean))],
      open_delay: Math.max(0, Math.round(draft.open_delay)),
      close_delay: Math.max(0, Math.round(draft.close_delay)),
    },
    sensors: {
      temperature: draft.temperature || null,
      humidity: draft.humidity || null,
    },
  };
  if (draft.id) payload.id = draft.id;
  return payload;
}

// --- Plans of a room --------------------------------------------------------------

const FROST_NAME = /\b(off|aus|frost\w*|fenster|window)\b/i;

/** Profile suggested for "window open": one named like off/frost/aus …, else none. */
export function defaultWindowProfile(profiles: { id: string; name: string }[]): string {
  return profiles.find((p) => FROST_NAME.test(p.name) || FROST_NAME.test(p.id))?.id ?? "";
}

/** Copy of a plan assigned to `room` (with the window reaction), or removed from its room. */
export function withRoom(plan: Plan, roomId: string | null, windowProfile = ""): Plan {
  const next = structuredClone(plan);
  delete next.status;
  delete next.room_missing;
  if (!roomId) {
    delete next.room;
    delete next.room_reactions;
    return next;
  }
  next.room = roomId;
  next.room_reactions = windowProfile ? { window: windowProfile } : {};
  return next;
}

/** Copy of a plan with a new window reaction ("" = ignore windows). */
export function withWindowReaction(plan: Plan, profileId: string): Plan {
  const next = structuredClone(plan);
  delete next.status;
  delete next.room_missing;
  next.room_reactions = profileId ? { window: profileId } : {};
  return next;
}

/** Entities whose state shows on a room tile or in the window state: contacts and sensors. */
export function watchedRoomEntities(room: Room): string[] {
  return [
    ...room.windows.entities,
    ...[room.sensors.temperature, room.sensors.humidity].filter((x): x is string => !!x),
  ];
}
