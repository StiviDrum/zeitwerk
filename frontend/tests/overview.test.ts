import { describe, expect, it } from "vitest";
import { localizer } from "../src/localize";
import {
  gridRows,
  hassChanged,
  overviewRow,
  stripStatus,
  timeStepOf,
  watchedEntities,
  type ViewCtx,
} from "../src/plan-view";
import type { HomeAssistant, Plan } from "../src/types";

const setValue = (value: number) => [
  { action: "input_number.set_value", target: { entity_id: "input_number.temp" }, data: { value } },
];

function plan(extra: Partial<Plan> = {}): Plan {
  return {
    id: "heat",
    name: "Heizung",
    enabled: true,
    icon: null,
    tags: [],
    profiles: [
      { id: "comfort", name: "Komfort", color: "#ff8b4a", icon: null, actions: setValue(22) },
      { id: "eco", name: "Absenkung", color: "#6fa8ff", icon: null, actions: setValue(18) },
    ],
    default_profile: "eco",
    activation: { match: "all", conditions: [], when_inactive: "none", reevaluate: true },
    holidays: { source: null, mode: "off", like_day: null, day_type: null },
    week: { day_types: [] },
    overrides: [],
    options: {},
    status: {
      profile: "comfort",
      source: "block",
      day_type: null,
      is_holiday: false,
      active: true,
      next_change: "2026-11-16T22:00:00+01:00",
      next_profile: "eco",
      forced_until: null,
      error: null,
    },
    ...extra,
  };
}

const hass = {
  states: {
    "input_number.temp": {
      entity_id: "input_number.temp",
      state: "21",
      attributes: { min: 5, max: 30, step: 0.5, unit_of_measurement: "°C" },
    },
  },
  config: { time_zone: "Europe/Berlin", unit_system: { temperature: "°C" } },
} as unknown as HomeAssistant;

const ctx: ViewCtx = { hass, l: localizer("en") };

describe("overviewRow", () => {
  it("shows the current profile with value and the next change", () => {
    const row = overviewRow(ctx, plan());
    expect(row.id).toBe("heat");
    expect(row.icon).toBe("mdi:calendar-clock");
    expect(row.profile).toMatchObject({ name: "Komfort", color: "#ff8b4a" });
    expect(row.profile?.value).toContain("22");
    expect(row.next?.when).toMatch(/^from /);
    expect(row.next?.label).toContain("18");
    expect(row.state).toBe("");
  });

  it("reports an off plan without profile chip or next change", () => {
    const row = overviewRow(ctx, plan({ enabled: false }));
    expect(row.profile).toBeNull();
    expect(row.next).toBeNull();
    expect(row.state).toBe("Plan off");
  });

  it("reports a paused plan", () => {
    const p = plan();
    p.status = { ...p.status!, profile: null, source: "inactive", active: false };
    const row = overviewRow(ctx, p);
    expect(row.profile).toBeNull();
    expect(row.state).toMatch(/paused/);
  });

  it("reports errors and survives a missing status or hass", () => {
    const p = plan();
    p.status = { ...p.status!, error: "boom" };
    expect(overviewRow(ctx, p).state).toBe("Error: boom");
    const bare = overviewRow({ l: localizer("de") }, plan({ status: null }));
    expect(bare.profile).toBeNull();
    expect(bare.next).toBeNull();
  });

  it("localizes (de)", () => {
    expect(overviewRow({ hass, l: localizer("de") }, plan({ enabled: false })).state).toBe(
      "Plan aus",
    );
  });
});

describe("watchedEntities", () => {
  it("includes the switch, quick-view entities and condition entities", () => {
    const p = plan({
      activation: {
        match: "all",
        conditions: [{ condition: "state", entity_id: "input_boolean.heating", state: "on" }],
        when_inactive: "none",
        reevaluate: true,
      },
    });
    const ids = watchedEntities(p);
    expect(ids).toContain("switch.zeitwerk_heat");
    expect(ids).toContain("input_number.temp");
    expect(ids).toContain("input_boolean.heating");
    expect(watchedEntities(p, false)).not.toContain("input_boolean.heating");
  });
});

describe("gridRows", () => {
  it("has seven weekday rows and a holiday row with own day type", () => {
    expect(gridRows(ctx, plan())).toHaveLength(7);
    const p = plan({
      holidays: { source: "calendar.x", mode: "own_day_type", like_day: null, day_type: "hol" },
      week: { day_types: [{ id: "hol", name: "Feiertag", days: [], blocks: [] }] },
    });
    const rows = gridRows(ctx, p);
    expect(rows).toHaveLength(8);
    expect(rows[7].key).toBe("holiday");
  });
});

describe("timeStepOf", () => {
  it("reads options.time_step with fallback 15", () => {
    expect(timeStepOf(plan())).toBe(15);
    expect(timeStepOf(plan({ options: { time_step: 30 } }))).toBe(30);
    expect(timeStepOf(plan({ options: { time_step: 7 } }))).toBe(15);
    expect(timeStepOf(plan({ options: { time_step: "10" } }))).toBe(10);
  });
});

describe("stripStatus", () => {
  it("drops all read-only keys the backend rejects", () => {
    const stripped = stripStatus(plan({ room: "r", room_missing: true }));
    expect(stripped.status).toBeUndefined();
    expect("room_missing" in stripped).toBe(false);
    expect(stripped.room).toBe("r");
  });
});

describe("hassChanged", () => {
  const base = {
    states: { "sensor.a": { state: "1" } },
    areas: {},
    floors: {},
  } as unknown as HomeAssistant;
  it("ignores unrelated state changes", () => {
    const next = {
      ...base,
      states: { ...base.states, "sensor.other": { state: "2" } },
    } as unknown as HomeAssistant;
    expect(hassChanged(base, next, ["sensor.a"])).toBe(false);
  });
  it("reacts to watched entities, areas and floors", () => {
    const state = { ...base, states: { "sensor.a": { state: "2" } } } as unknown as HomeAssistant;
    expect(hassChanged(base, state, ["sensor.a"])).toBe(true);
    expect(hassChanged(base, { ...base, areas: {} }, [])).toBe(true);
    expect(hassChanged(base, { ...base, floors: {} }, [])).toBe(true);
    expect(hassChanged(base, { ...base, language: "de" }, [])).toBe(true);
  });
});
