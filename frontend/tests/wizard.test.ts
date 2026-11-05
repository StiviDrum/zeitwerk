import { describe, expect, it } from "vitest";
import { buildPlan, draftErrors, seedProfiles, targetKind, type WizardDraft } from "../src/wizard";
import type { Profile } from "../src/types";

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
});

describe("buildPlan", () => {
  const set = (entity: string, value: number) => [
    { action: "input_number.set_value", target: { entity_id: entity }, data: { value } },
  ];
  const profiles: Profile[] = [
    {
      id: "komfort",
      name: "Komfort",
      color: "#ff8b4a",
      icon: null,
      actions: set("input_number.t", 22),
    },
    {
      id: "absenkung",
      name: "Absenkung",
      color: "#6fa8ff",
      icon: null,
      actions: set("input_number.t", 18),
    },
  ];
  const draft: WizardDraft = {
    name: " Heizung Bad ",
    icon: "mdi:radiator",
    tags: ["heizung", " "],
    layout: "week",
  };

  it("creates a valid week plan with the edited profiles", () => {
    const plan = buildPlan(draft, profiles, "absenkung", labels);
    expect(plan.name).toBe("Heizung Bad");
    expect(plan.tags).toEqual(["heizung"]);
    expect(plan.default_profile).toBe("absenkung");
    expect(plan).not.toHaveProperty("id");
    expect(plan.profiles).toBe(profiles);
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
    const plan = buildPlan({ ...draft, layout: "daily", id: "bad" }, profiles, "komfort", labels);
    expect(plan.id).toBe("bad");
    const week = plan.week as { day_types: { days: string[]; blocks: { profile: string }[] }[] };
    expect(week.day_types).toHaveLength(1);
    expect(week.day_types[0].days).toHaveLength(7);
    expect(week.day_types[0].blocks[0].profile).toBe("absenkung");
  });
  it("a single profile gives empty day types", () => {
    const plan = buildPlan(draft, profiles.slice(0, 1), "komfort", labels);
    const week = plan.week as { day_types: { blocks: unknown[] }[] };
    expect(week.day_types.every((d) => d.blocks.length === 0)).toBe(true);
  });
  it("seeds three profiles without actions and validates the name", () => {
    const seed = seedProfiles(NAMES);
    expect(seed.map((p) => [p.name, p.actions.length])).toEqual([
      ["Komfort", 0],
      ["Absenkung", 0],
      ["Abwesend", 0],
    ]);
    expect(draftErrors(draft)).toEqual([]);
    expect(draftErrors({ ...draft, name: " " })).toEqual(["name_required"]);
  });
});
