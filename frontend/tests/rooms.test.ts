import { describe, expect, it } from "vitest";
import {
  applyArea,
  defaultWindowProfile,
  draftErrors,
  draftFromRoom,
  emptyDraft,
  entityArea,
  floorGroups,
  hintText,
  roomClimate,
  roomHints,
  roomIcon,
  roomPayload,
  suggestions,
  windowView,
  withRoom,
  watchedRoomEntities,
  withWindowReaction,
} from "../src/rooms";
import { localizer } from "../src/localize";
import type { HomeAssistant, Plan, Room } from "../src/types";

function room(id: string, extra: Partial<Room> = {}): Room {
  return {
    id,
    name: id,
    area_id: null,
    icon: null,
    windows: { entities: [], open_delay: 60, close_delay: 0 },
    sensors: { temperature: null, humidity: null },
    window: null,
    area_missing: false,
    plans: [],
    ...extra,
  };
}

const hass = {
  states: {
    "binary_sensor.win_a": {
      entity_id: "binary_sensor.win_a",
      state: "off",
      attributes: { device_class: "window", friendly_name: "Window A" },
    },
    "binary_sensor.door_a": {
      entity_id: "binary_sensor.door_a",
      state: "off",
      attributes: { device_class: "door" },
    },
    "binary_sensor.motion_a": {
      entity_id: "binary_sensor.motion_a",
      state: "off",
      attributes: { device_class: "motion" },
    },
    "binary_sensor.win_b": {
      entity_id: "binary_sensor.win_b",
      state: "off",
      attributes: { device_class: "window" },
    },
    "binary_sensor.win_dev": {
      entity_id: "binary_sensor.win_dev",
      state: "off",
      attributes: { device_class: "opening" },
    },
    "sensor.temp_a": {
      entity_id: "sensor.temp_a",
      state: "21.5",
      attributes: { device_class: "temperature", unit_of_measurement: "°C" },
    },
    "sensor.hum_a": {
      entity_id: "sensor.hum_a",
      state: "48",
      attributes: { device_class: "humidity", unit_of_measurement: "%" },
    },
    "sensor.gone": { entity_id: "sensor.gone", state: "unavailable", attributes: {} },
  },
  areas: {
    living: { area_id: "living", name: "Living", floor_id: "ground", icon: "mdi:sofa" },
    bed: {
      area_id: "bed",
      name: "Bedroom",
      floor_id: "upper",
      temperature_entity_id: "sensor.temp_a",
    },
    shed: { area_id: "shed", name: "Shed", floor_id: null },
    ghostfloor: { area_id: "ghostfloor", name: "Ghost", floor_id: "deleted" },
  },
  floors: {
    upper: { floor_id: "upper", name: "Upper", level: 1 },
    ground: { floor_id: "ground", name: "Ground", level: 0 },
    cellar: { floor_id: "cellar", name: "Cellar", level: null },
  },
  devices: { dev1: { id: "dev1", area_id: "living" } },
  entities: {
    "binary_sensor.win_a": { entity_id: "binary_sensor.win_a", area_id: "living" },
    "binary_sensor.door_a": { entity_id: "binary_sensor.door_a", device_id: "dev1" },
    "binary_sensor.motion_a": { entity_id: "binary_sensor.motion_a", area_id: "living" },
    "binary_sensor.win_b": { entity_id: "binary_sensor.win_b", area_id: "bed" },
    // entity area wins over its device's area
    "binary_sensor.win_dev": {
      entity_id: "binary_sensor.win_dev",
      device_id: "dev1",
      area_id: "bed",
    },
    "sensor.temp_a": { entity_id: "sensor.temp_a", area_id: "living" },
    "sensor.hum_a": { entity_id: "sensor.hum_a", device_id: "dev1" },
  },
} as unknown as HomeAssistant;

describe("floorGroups", () => {
  it("orders floors by level, rooms without floor last", () => {
    const rooms = [
      room("a", { area_id: "bed", name: "Bedroom" }),
      room("b", { area_id: "living", name: "Living room" }),
      room("c", { area_id: "shed", name: "Shed" }),
      room("d", { area_id: null, name: "No area" }),
      room("e", { area_id: "gone", name: "Area deleted", area_missing: true }),
      room("f", { area_id: "ghostfloor", name: "Ghost" }),
    ];
    const groups = floorGroups(rooms, hass, "Other");
    expect(groups.map((g) => g.name)).toEqual(["Ground", "Upper", "Other"]);
    expect(groups[0].rooms.map((r) => r.id)).toEqual(["b"]);
    expect(groups[2].floorId).toBeNull();
    expect(groups[2].rooms.map((r) => r.id).sort()).toEqual(["c", "d", "e", "f"]);
  });

  it("puts floors without level after floors with level and sorts by name", () => {
    const rooms = [room("x", { area_id: null })];
    const h = {
      ...hass,
      areas: { c1: { area_id: "c1", name: "C", floor_id: "cellar" }, ...hass.areas },
    } as HomeAssistant;
    const groups = floorGroups(
      [room("c", { area_id: "c1" }), ...rooms, room("u", { area_id: "bed" })],
      h,
      "Other",
    );
    expect(groups.map((g) => g.name)).toEqual(["Upper", "Cellar", "Other"]);
  });

  it("works without registries and without rooms", () => {
    expect(floorGroups([], hass, "Other")).toEqual([]);
    const groups = floorGroups([room("a", { area_id: "bed" })], undefined, "Other");
    expect(groups).toHaveLength(1);
    expect(groups[0].floorId).toBeNull();
  });
});

describe("room tile data", () => {
  it("falls back from room icon to area icon to default", () => {
    expect(roomIcon(room("a", { icon: "mdi:x", area_id: "living" }), hass)).toBe("mdi:x");
    expect(roomIcon(room("a", { area_id: "living" }), hass)).toBe("mdi:sofa");
    expect(roomIcon(room("a", { area_id: "bed" }), hass)).toBe("mdi:door");
    expect(roomIcon(room("a"), undefined)).toBe("mdi:door");
  });

  it("shapes the window state", () => {
    expect(windowView(room("a"))).toEqual({ kind: "none", problem: false });
    const base = { windows: { entities: ["binary_sensor.win_a"], open_delay: 0, close_delay: 0 } };
    const win = (open: boolean, unavailable: string[] = []) => ({
      open,
      open_since: null,
      entities: {},
      unavailable,
    });
    expect(windowView(room("a", { ...base, window: win(true) }))).toEqual({
      kind: "open",
      problem: false,
    });
    expect(windowView(room("a", { ...base, window: win(false) })).kind).toBe("closed");
    expect(windowView(room("a", { ...base, window: win(false, ["binary_sensor.win_a"]) }))).toEqual(
      {
        kind: "closed",
        problem: true,
      },
    );
    expect(windowView(room("a", { ...base, window: win(true, ["x"]) }))).toEqual({
      kind: "open",
      problem: true,
    });
    // tracker missing but contacts configured: shown as closed
    expect(windowView(room("a", { ...base, window: null })).kind).toBe("closed");
  });

  it("formats temperature and humidity, skipping unavailable sensors", () => {
    const r = room("a", { sensors: { temperature: "sensor.temp_a", humidity: "sensor.hum_a" } });
    expect(roomClimate(r, hass)).toEqual({ temperature: "21.5 °C", humidity: "48 %" });
    const gone = room("a", { sensors: { temperature: "sensor.gone", humidity: "sensor.nope" } });
    expect(roomClimate(gone, hass)).toEqual({ temperature: "", humidity: "" });
    expect(roomClimate(room("a"), hass)).toEqual({ temperature: "", humidity: "" });
  });
});

describe("hints", () => {
  const plan = (id: string, extra: Partial<Plan> = {}) =>
    ({ id, name: id.toUpperCase(), ...extra }) as Plan;

  it("collects missing rooms, missing areas and unavailable contacts", () => {
    const rooms = [
      room("r1", { area_missing: true }),
      room("r2", {
        window: { open: false, open_since: null, entities: {}, unavailable: ["binary_sensor.x"] },
      }),
      room("r3"),
    ];
    const plans = [plan("p1", { room: "ghost", room_missing: true }), plan("p2", { room: "r3" })];
    const hints = roomHints(rooms, plans);
    expect(hints.map((h) => h.kind)).toEqual([
      "plan_room_missing",
      "area_missing",
      "window_unavailable",
    ]);
    const l = localizer("en");
    expect(hintText(hints[0], l)).toContain("ghost");
    expect(hintText(hints[2], l)).toContain("binary_sensor.x");
    expect(roomHints([], [])).toEqual([]);
  });
});

describe("suggestions", () => {
  it("finds window/door/opening contacts of an area via entity or device area", () => {
    expect(suggestions(hass, "living").windows).toEqual([
      "binary_sensor.door_a",
      "binary_sensor.win_a",
    ]);
    expect(suggestions(hass, "bed").windows).toEqual([
      "binary_sensor.win_b",
      "binary_sensor.win_dev",
    ]);
  });

  it("finds climate sensors and the area's own entities", () => {
    const living = suggestions(hass, "living");
    expect(living.temperature).toEqual(["sensor.temp_a"]);
    expect(living.humidity).toEqual(["sensor.hum_a"]);
    expect(suggestions(hass, "bed").areaTemperature).toBe("sensor.temp_a");
  });

  it("is empty without area or hass", () => {
    expect(suggestions(hass, null).windows).toEqual([]);
    expect(suggestions(undefined, "living").windows).toEqual([]);
    expect(entityArea(hass, "binary_sensor.unknown")).toBeNull();
  });
});

describe("room editor draft", () => {
  it("prefills name, sensors and (new rooms) windows from the area", () => {
    const d = applyArea(emptyDraft(), "living", hass, true);
    expect(d.name).toBe("Living");
    expect(d.temperature).toBe("sensor.temp_a");
    expect(d.humidity).toBe("sensor.hum_a");
    expect(d.windows).toEqual(["binary_sensor.door_a", "binary_sensor.win_a"]);
  });

  it("keeps a hand-edited name and existing values; windows only on request", () => {
    const d = applyArea(
      { ...emptyDraft(), name: "Mine", nameTouched: true, temperature: "sensor.own" },
      "living",
      hass,
    );
    expect(d.name).toBe("Mine");
    expect(d.temperature).toBe("sensor.own");
    expect(d.windows).toEqual([]);
  });

  it("replaces auto-filled values when the area changes but keeps hand-set ones", () => {
    let d = applyArea(emptyDraft(), "living", hass, true);
    expect(d.temperature).toBe("sensor.temp_a");
    d = applyArea(d, "bed", hass, true);
    expect(d.temperature).toBe("sensor.temp_a"); // bed's own temperature entity
    expect(d.humidity).toBe(""); // living's auto humidity is gone, bed has none
    expect(d.windows).toEqual(["binary_sensor.win_b", "binary_sensor.win_dev"]);
    // hand-set values survive
    d = { ...d, humidity: "sensor.mine", windows: ["binary_sensor.win_b"] };
    d = applyArea(d, "living", hass, true);
    expect(d.humidity).toBe("sensor.mine");
    expect(d.windows).toEqual(["binary_sensor.win_b"]);
  });

  it("watches contacts and sensors of a room", () => {
    const r = room("a", {
      windows: { entities: ["binary_sensor.win_a"], open_delay: 0, close_delay: 0 },
      sensors: { temperature: "sensor.temp_a", humidity: null },
    });
    expect(watchedRoomEntities(r)).toEqual(["binary_sensor.win_a", "sensor.temp_a"]);
  });

  it("validates and builds create/update payloads", () => {
    expect(draftErrors(emptyDraft())).toEqual(["name_required"]);
    const d = {
      ...emptyDraft(),
      name: "  Living  ",
      area_id: "living",
      windows: ["binary_sensor.win_a", "binary_sensor.win_a", ""],
      open_delay: 30,
      temperature: "sensor.temp_a",
    };
    expect(draftErrors(d)).toEqual([]);
    expect(roomPayload(d)).toEqual({
      name: "Living",
      area_id: "living",
      icon: null,
      windows: { entities: ["binary_sensor.win_a"], open_delay: 30, close_delay: 0 },
      sensors: { temperature: "sensor.temp_a", humidity: null },
    });
  });

  it("round-trips an existing room and sends its id on update", () => {
    const r = room("living", {
      name: "Living room",
      area_id: "living",
      icon: "mdi:sofa",
      windows: { entities: ["binary_sensor.win_a"], open_delay: 120, close_delay: 5 },
      sensors: { temperature: "sensor.temp_a", humidity: null },
    });
    const payload = roomPayload(draftFromRoom(r));
    expect(payload).toMatchObject({
      id: "living",
      name: "Living room",
      area_id: "living",
      icon: "mdi:sofa",
      windows: { entities: ["binary_sensor.win_a"], open_delay: 120, close_delay: 5 },
    });
  });
});

describe("plans of a room", () => {
  const plan = {
    id: "heat",
    name: "Heat",
    profiles: [
      { id: "comfort", name: "Comfort" },
      { id: "frost", name: "Frostschutz" },
    ],
    status: { profile: "comfort" },
    room_missing: true,
  } as unknown as Plan;

  it("suggests a profile named like off/frost/aus", () => {
    expect(defaultWindowProfile(plan.profiles)).toBe("frost");
    expect(defaultWindowProfile([{ id: "a", name: "Aus" }])).toBe("a");
    expect(defaultWindowProfile([{ id: "a", name: "Absenkung" }])).toBe("");
    expect(defaultWindowProfile([{ id: "a", name: "Zu Hause" }])).toBe("");
    expect(defaultWindowProfile([])).toBe("");
  });

  it("assigns and removes a plan without status fields", () => {
    const assigned = withRoom(plan, "living", "frost");
    expect(assigned.room).toBe("living");
    expect(assigned.room_reactions).toEqual({ window: "frost" });
    expect(assigned.status).toBeUndefined();
    expect(assigned.room_missing).toBeUndefined();
    expect(withRoom(plan, "living").room_reactions).toEqual({});
    const removed = withRoom(assigned, null);
    expect(removed.room).toBeUndefined();
    expect(removed.room_reactions).toBeUndefined();
  });

  it("changes the window reaction", () => {
    const base = withRoom(plan, "living", "frost");
    expect(withWindowReaction(base, "comfort").room_reactions).toEqual({ window: "comfort" });
    expect(withWindowReaction(base, "").room_reactions).toEqual({});
    expect(base.room_reactions).toEqual({ window: "frost" }); // input untouched
  });
});
