import { describe, expect, it } from "vitest";
import {
  conditionSummary,
  conditionsSummary,
  moveItem,
  pauseReason,
  uniqueId,
} from "../src/conditions";
import { localizer } from "../src/localize";
import type { HomeAssistant } from "../src/types";

const de = localizer("de");
const hass = {
  states: {
    "input_boolean.urlaub": {
      entity_id: "input_boolean.urlaub",
      state: "off",
      attributes: { friendly_name: "Urlaub" },
    },
    "input_boolean.heizperiode": {
      entity_id: "input_boolean.heizperiode",
      state: "off",
      attributes: { friendly_name: "Heizperiode" },
    },
    "sensor.aussen": {
      entity_id: "sensor.aussen",
      state: "12",
      attributes: { friendly_name: "Außen" },
    },
  },
  formatEntityState: (_e: unknown, s?: string) =>
    s === "on" ? "An" : s === "off" ? "Aus" : String(s),
} as unknown as HomeAssistant;

describe("condition summaries", () => {
  it("state, numeric_state, time, template, groups, alias", () => {
    expect(
      conditionSummary(
        { condition: "state", entity_id: "input_boolean.urlaub", state: "on" },
        hass,
        de,
      ),
    ).toBe("Urlaub ist An");
    expect(
      conditionSummary(
        { condition: "numeric_state", entity_id: "sensor.aussen", below: 15 },
        hass,
        de,
      ),
    ).toBe("Außen < 15");
    expect(
      conditionSummary({ condition: "time", after: "08:00:00", before: "12:00" }, hass, de),
    ).toBe("Zeit 08:00–12:00");
    expect(conditionSummary({ condition: "template", value_template: "{{ 1 }}" }, hass, de)).toBe(
      "Template",
    );
    expect(conditionSummary({ condition: "or", conditions: [{}, {}] }, hass, de)).toBe(
      "eine von 2",
    );
    expect(conditionSummary({ condition: "state", alias: "Niemand da" }, hass, de)).toBe(
      "Niemand da",
    );
    expect(
      conditionSummary(
        { condition: "state", entity_id: "person.unknown", state: "not_home" },
        undefined,
        de,
      ),
    ).toBe("person.unknown ist not_home");
  });
  it("lists with match prefix", () => {
    const conds = [
      { condition: "state", entity_id: "input_boolean.urlaub", state: "on" },
      { condition: "state", entity_id: "input_boolean.heizperiode", state: "on" },
    ];
    expect(conditionsSummary(conds, "all", hass, de)).toBe(
      "alle: Urlaub ist An · Heizperiode ist An",
    );
    expect(conditionsSummary(conds.slice(0, 1), "any", hass, de)).toBe("Urlaub ist An");
    expect(conditionsSummary([], "all", hass, de)).toBe("keine Bedingungen");
  });
  it("pause reason shows the current state of the first failing condition", () => {
    const conds = [
      { condition: "state", entity_id: "input_boolean.urlaub", state: "off" },
      { condition: "state", entity_id: "input_boolean.heizperiode", state: "on" },
    ];
    expect(pauseReason(conds, [true, false], hass, de)).toBe("Heizperiode: Aus");
    expect(pauseReason(conds, [true, true], hass, de)).toBe("");
    expect(pauseReason([{ condition: "template" }], [false], hass, de)).toBe("Template");
  });
});

describe("rule helpers", () => {
  it("unique slug ids", () => {
    expect(uniqueId("Niemand zu Hause", [])).toBe("niemand_zu_hause");
    expect(uniqueId("Urlaub", ["urlaub"])).toBe("urlaub_2");
    expect(uniqueId("Größe & Wärme", [])).toBe("groesse_waerme");
    expect(uniqueId("!!!", [])).toBe("rule");
  });
  it("moves items", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a"], 5, 0)).toEqual(["a"]);
  });
});
