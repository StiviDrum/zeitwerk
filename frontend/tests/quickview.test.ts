import { describe, expect, it } from "vitest";
import {
  controlFor,
  formatValue,
  fraction,
  quickValue,
  snapValue,
  toggledActions,
} from "../src/quickview";
import type { Profile } from "../src/types";

const profile = (actions: Profile["actions"]): Profile => ({
  id: "p",
  name: "P",
  color: null,
  icon: null,
  actions,
});

const setValue = (value: unknown) =>
  profile([
    {
      action: "input_number.set_value",
      target: { entity_id: "input_number.temperaturspeicher_wohnzimmer" },
      data: { value },
    },
  ]);

describe("quickValue detection", () => {
  it("detects a single entity / single value action", () => {
    expect(quickValue(setValue(22))).toEqual({
      kind: "value",
      entityId: "input_number.temperaturspeicher_wohnzimmer",
      key: "value",
      value: 22,
    });
  });
  it("detects climate temperature and legacy service key", () => {
    const qv = quickValue(
      profile([
        { service: "climate.set_temperature", entity_id: "climate.bad", data: { temperature: 21 } },
      ]),
    );
    expect(qv).toMatchObject({ kind: "value", key: "temperature", value: 21 });
  });
  it("detects on/off actions", () => {
    expect(
      quickValue(profile([{ action: "switch.turn_on", target: { entity_id: "switch.x" } }])),
    ).toEqual({
      kind: "toggle",
      entityId: "switch.x",
      on: true,
    });
  });
  it("rejects complex profiles", () => {
    expect(quickValue(undefined)).toBeNull();
    expect(quickValue(profile([]))).toBeNull();
    expect(
      quickValue(
        profile([
          {
            action: "input_number.set_value",
            target: { entity_id: "input_number.a" },
            data: { value: 1 },
          },
          {
            action: "input_number.set_value",
            target: { entity_id: "input_number.b" },
            data: { value: 2 },
          },
        ]),
      ),
    ).toBeNull();
    expect(
      quickValue(
        profile([
          {
            action: "input_number.set_value",
            target: { entity_id: ["a.a", "a.b"] },
            data: { value: 1 },
          },
        ]),
      ),
    ).toBeNull();
    expect(
      quickValue(
        profile([
          { action: "script.turn_on", target: { entity_id: "script.x" }, data: { variables: {} } },
        ]),
      ),
    ).toBeNull();
    expect(quickValue(profile([{ delay: "00:01:00" }]))).toBeNull();
  });
});

describe("controls", () => {
  it("uses input_number min/max/step/unit", () => {
    const qv = quickValue(setValue(22))!;
    const control = controlFor(qv, {
      entity_id: "input_number.t",
      state: "22",
      attributes: { min: 10, max: 30, step: 0.5, unit_of_measurement: "°C" },
    });
    expect(control).toEqual({ type: "number", min: 10, max: 30, step: 0.5, unit: "°C" });
    expect(formatValue(qv, control, "de", ["An", "Aus"])).toBe("22,0 °C");
    expect(formatValue(qv, control, "en", ["On", "Off"])).toBe("22.0 °C");
  });
  it("falls back when the entity is unknown", () => {
    const qv = quickValue(setValue(5))!;
    expect(controlFor(qv, undefined)).toEqual({
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "",
    });
  });
  it("select and percent controls", () => {
    const sel = quickValue(
      profile([
        {
          action: "input_select.select_option",
          target: { entity_id: "input_select.m" },
          data: { option: "Eco" },
        },
      ]),
    )!;
    expect(
      controlFor(sel, {
        entity_id: "input_select.m",
        state: "Eco",
        attributes: { options: ["Eco", "Boost"] },
      }),
    ).toEqual({
      type: "select",
      options: ["Eco", "Boost"],
    });
    const light = quickValue(
      profile([
        { action: "light.turn_on", target: { entity_id: "light.l" }, data: { brightness_pct: 40 } },
      ]),
    )!;
    const control = controlFor(light, undefined);
    expect(formatValue(light, control, "de", ["An", "Aus"])).toBe("40 %");
  });
  it("slider maths", () => {
    expect(fraction(22, 10, 30)).toBeCloseTo(0.6);
    expect(fraction(50, 10, 30)).toBe(1);
    expect(fraction(1, 5, 5)).toBe(0);
    expect(snapValue(21.74, 10, 30, 0.5)).toBe(21.5);
    expect(snapValue(21.76, 10, 30, 0.5)).toBe(22);
    expect(snapValue(99, 10, 30, 0.5)).toBe(30);
  });
  it("toggles on/off actions", () => {
    const p = profile([{ action: "switch.turn_on", target: { entity_id: "switch.x" } }]);
    expect(toggledActions(p, false)).toEqual([
      { action: "switch.turn_off", target: { entity_id: "switch.x" } },
    ]);
  });
});
