import { describe, expect, it } from "vitest";
import {
  buildPlan,
  defaultProfiles,
  draftErrors,
  profileActions,
  targetKind,
  type WizardDraft,
} from "../src/wizard";

const labels = { workday: "Werktag", weekend: "Wochenende", daily: "Täglich" };
const NAMES: [string, string, string] = ["Komfort", "Absenkung", "Abwesend"];

describe("targetKind", () => {
  it("maps domains to value actions", () => {
    expect(
      targetKind("input_number.t", {
        entity_id: "input_number.t",
        state: "20",
        attributes: { min: 12, max: 26, step: 0.5, unit_of_measurement: "°C" },
      }),
    ).toEqual({
      kind: "number",
      service: "input_number.set_value",
      key: "value",
      min: 12,
      max: 26,
      step: 0.5,
      unit: "°C",
    });
    expect(targetKind("climate.bad")).toMatchObject({
      service: "climate.set_temperature",
      key: "temperature",
    });
    expect(
      targetKind("input_select.m", {
        entity_id: "input_select.m",
        state: "a",
        attributes: { options: ["a", "b"] },
      }),
    ).toEqual({
      kind: "select",
      service: "input_select.select_option",
      key: "option",
      options: ["a", "b"],
    });
    expect(targetKind("switch.pumpe")).toEqual({ kind: "toggle", domain: "switch" });
  });
  it("actions for toggles fall back to homeassistant.turn_on", () => {
    expect(profileActions("switch.p", { kind: "toggle", domain: "switch" }, true)).toEqual([
      { action: "switch.turn_on", target: { entity_id: "switch.p" } },
    ]);
    expect(profileActions("vacuum.x", { kind: "toggle", domain: "vacuum" }, false)).toEqual([
      { action: "homeassistant.turn_off", target: { entity_id: "vacuum.x" } },
    ]);
  });
});

describe("buildPlan", () => {
  const target = targetKind("input_number.t", {
    entity_id: "input_number.t",
    state: "20",
    attributes: { min: 5, max: 30, step: 0.5, unit_of_measurement: "°C" },
  });
  const draft: WizardDraft = {
    name: " Heizung Bad ",
    icon: "mdi:radiator",
    tags: ["heizung", " "],
    entityId: "input_number.t",
    profiles: defaultProfiles(target, NAMES),
    defaultIndex: 1,
    layout: "week",
  };
  it("creates a valid week plan", () => {
    const plan = buildPlan(draft, target, labels);
    expect(plan.name).toBe("Heizung Bad");
    expect(plan.tags).toEqual(["heizung"]);
    expect(plan.default_profile).toBe("absenkung");
    expect(plan).not.toHaveProperty("id");
    const profiles = plan.profiles as { id: string; actions: unknown[] }[];
    expect(profiles.map((p) => p.id)).toEqual(["komfort", "absenkung", "abwesend"]);
    expect(profiles[0].actions).toEqual([
      {
        action: "input_number.set_value",
        target: { entity_id: "input_number.t" },
        data: { value: 22 },
      },
    ]);
    const week = plan.week as {
      day_types: { id: string; days: string[]; blocks: { profile: string }[] }[];
    };
    expect(week.day_types.map((d) => [d.id, d.days.length, d.blocks.length])).toEqual([
      ["workday", 5, 2],
      ["weekend", 2, 1],
    ]);
    expect(week.day_types[0].blocks[0].profile).toBe("komfort");
  });
  it("daily layout and explicit id", () => {
    const plan = buildPlan(
      { ...draft, layout: "daily", id: "bad", defaultIndex: 0 },
      target,
      labels,
    );
    expect(plan.id).toBe("bad");
    const week = plan.week as { day_types: { days: string[]; blocks: { profile: string }[] }[] };
    expect(week.day_types).toHaveLength(1);
    expect(week.day_types[0].days).toHaveLength(7);
    expect(week.day_types[0].blocks[0].profile).toBe("absenkung");
  });
  it("duplicate profile names get unique ids", () => {
    const plan = buildPlan(
      { ...draft, profiles: [draft.profiles[0], { ...draft.profiles[1], name: "Komfort" }] },
      target,
      labels,
    );
    expect((plan.profiles as { id: string }[]).map((p) => p.id)).toEqual(["komfort", "komfort_2"]);
  });
  it("default values follow the entity range", () => {
    const pct = targetKind("light.l");
    expect(defaultProfiles(pct, NAMES).map((p) => p.value)).toEqual([100, 50, 0]);
    expect(
      defaultProfiles({ kind: "toggle", domain: "switch" }, NAMES).map((p) => p.value),
    ).toEqual([true, false, false]);
  });
  it("validates the draft", () => {
    expect(draftErrors(draft)).toEqual([]);
    expect(
      draftErrors({ ...draft, name: "", entityId: "x", profiles: draft.profiles.slice(0, 1) }),
    ).toEqual(["name_required", "entity_required", "profiles_required"]);
  });
});
