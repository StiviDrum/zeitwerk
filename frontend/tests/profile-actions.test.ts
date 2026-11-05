import { describe, expect, it } from "vitest";
import {
  adaptRow,
  assignIds,
  buildAction,
  defaultRow,
  nextColor,
  parseAction,
  parseProfile,
  profileUsage,
  replaceMissingProfiles,
  rowKind,
  sharedEntity,
} from "../src/profile-actions";
import type { Plan, Profile } from "../src/types";

const num = (entity: string, value: number) => ({
  action: "input_number.set_value",
  target: { entity_id: entity },
  data: { value },
});

describe("rows", () => {
  it("parses simple actions and rejects complex ones", () => {
    expect(parseAction(num("input_number.t", 21))).toEqual({
      entityId: "input_number.t",
      on: true,
      value: 21,
    });
    expect(parseAction({ action: "light.turn_on", target: { entity_id: "light.a" } })).toEqual({
      entityId: "light.a",
      on: true,
      value: null,
    });
    expect(
      parseAction({
        action: "light.turn_on",
        target: { entity_id: "light.a" },
        data: { brightness_pct: 40 },
      }),
    ).toEqual({ entityId: "light.a", on: true, value: 40 });
    expect(parseAction({ service: "switch.turn_off", entity_id: "switch.x" })).toEqual({
      entityId: "switch.x",
      on: false,
      value: null,
    });
    expect(
      parseAction({ action: "light.turn_on", target: { entity_id: ["light.a", "light.b"] } }),
    ).toBeNull();
    expect(
      parseAction({
        action: "script.turn_on",
        target: { entity_id: "script.x" },
        data: { variables: {} },
      }),
    ).toBeNull();
    expect(parseAction({ delay: "00:01:00" })).toBeNull();
    expect(parseProfile({ actions: [num("input_number.t", 1), { delay: 5 }] })).toBeNull();
    expect(parseProfile({ actions: [] })).toEqual([]);
  });

  it("builds actions per entity kind (round trip)", () => {
    const cases = [
      num("input_number.t", 21),
      {
        action: "climate.set_temperature",
        target: { entity_id: "climate.a" },
        data: { temperature: 20.5 },
      },
      { action: "light.turn_on", target: { entity_id: "light.a" }, data: { brightness_pct: 40 } },
      { action: "light.turn_on", target: { entity_id: "light.a" } },
      { action: "light.turn_off", target: { entity_id: "light.a" } },
      { action: "switch.turn_off", target: { entity_id: "switch.x" } },
      {
        action: "input_select.select_option",
        target: { entity_id: "input_select.m" },
        data: { option: "Eco" },
      },
      {
        action: "cover.set_cover_position",
        target: { entity_id: "cover.r" },
        data: { position: 30 },
      },
    ];
    for (const action of cases) {
      expect(buildAction(parseAction(action)!)).toEqual(action);
    }
    expect(buildAction({ entityId: "scene.abend", on: true, value: null })).toEqual({
      action: "scene.turn_on",
      target: { entity_id: "scene.abend" },
    });
    expect(buildAction({ entityId: "vacuum.r", on: true, value: null })).toEqual({
      action: "homeassistant.turn_on",
      target: { entity_id: "vacuum.r" },
    });
  });

  it("defaults and adapts values to the entity", () => {
    const climate = rowKind("climate.a", {
      entity_id: "climate.a",
      state: "heat",
      attributes: { min_temp: 5, max_temp: 30, target_temp_step: 0.5 },
    });
    expect(defaultRow("climate.a", climate, 1).value).toBe(18);
    const select = rowKind("input_select.m", {
      entity_id: "input_select.m",
      state: "A",
      attributes: { options: ["A", "B"] },
    });
    expect(defaultRow("input_select.m", select, 1).value).toBe("B");
    expect(adaptRow({ entityId: "x", on: true, value: 99 }, "climate.a", climate).value).toBe(30);
    expect(adaptRow({ entityId: "x", on: true, value: "B" }, "input_select.m", select).value).toBe(
      "B",
    );
    expect(adaptRow({ entityId: "x", on: true, value: 3 }, "input_select.m", select).value).toBe(
      "A",
    );
    expect(
      adaptRow({ entityId: "x", on: false, value: 3 }, "switch.s", rowKind("switch.s")),
    ).toEqual({
      entityId: "switch.s",
      on: false,
      value: null,
    });
  });
});

describe("profiles", () => {
  const p = (id: string, actions: Profile["actions"]): Profile => ({
    id,
    name: id,
    color: null,
    icon: null,
    actions,
  });

  it("detects a shared entity", () => {
    expect(
      sharedEntity([p("a", [num("input_number.t", 1)]), p("b", [num("input_number.t", 2)])]),
    ).toBe("input_number.t");
    expect(
      sharedEntity([p("a", [num("input_number.t", 1)]), p("b", [num("input_number.u", 2)])]),
    ).toBeNull();
    expect(sharedEntity([p("a", [num("input_number.t", 1), num("input_number.u", 1)])])).toBeNull();
  });

  it("assigns ids and colours", () => {
    const out = assignIds([
      { id: "komfort", name: "Komfort" },
      { id: "", name: "Komfort" },
      { id: "", name: "Nacht ä" },
    ]);
    expect(out.map((x) => x.id)).toEqual(["komfort", "komfort_2", "nacht_ae"]);
    expect(nextColor([{ color: "#FF8B4A" }])).toBe("#6fa8ff");
  });

  it("falls back to the default profile when a profile is removed", () => {
    const plan = {
      profiles: [p("eco", [])],
      default_profile: "eco",
      week: {
        day_types: [
          {
            id: "d",
            name: "d",
            days: ["mon"],
            blocks: [
              { start: "06:00", end: "08:00", profile: "comfort" },
              { start: "08:00", end: "09:00", profile: "eco" },
            ],
          },
        ],
      },
      overrides: [{ id: "o", name: "o", profile: "away", match: "all", conditions: [] }],
      activation: { match: "all", conditions: [], when_inactive: "profile:away", reevaluate: true },
    } as unknown as Plan;
    expect(profileUsage(plan, "away")).toEqual({ blocks: 0, rules: 2 });
    expect(profileUsage(plan, "comfort")).toEqual({ blocks: 1, rules: 0 });
    replaceMissingProfiles(plan);
    expect(plan.week.day_types[0].blocks).toEqual([
      { start: "08:00", end: "09:00", profile: "eco" },
    ]);
    expect(plan.overrides[0].profile).toBe("eco");
    expect(plan.activation.when_inactive).toBe("profile:eco");
  });
});
