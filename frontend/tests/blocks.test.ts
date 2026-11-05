import { describe, expect, it } from "vitest";
import { normalize, rowSegments, subtract, toInterval } from "../src/blocks";
import type { Block, DayType } from "../src/types";

const b = (start: string, end: string, profile = "comfort"): Block => ({ start, end, profile });

describe("interval conversion", () => {
  it("handles normal, 24:00 and midnight blocks", () => {
    expect(toInterval(b("16:00", "22:00"))).toEqual({ start: 960, end: 1320, profile: "comfort" });
    expect(toInterval(b("09:00", "24:00")).end).toBe(1440);
    expect(toInterval(b("22:00", "06:00"))).toEqual({ start: 1320, end: 1800, profile: "comfort" });
    expect(toInterval(b("00:00", "00:00")).end).toBe(1440);
  });
});

describe("normalize / subtract", () => {
  it("sorts, drops empty and merges touching blocks of one profile", () => {
    const iv = (start: number, end: number, profile = "comfort") => ({ start, end, profile });
    expect(
      normalize([iv(600, 700), iv(360, 480), iv(480, 600), iv(800, 800), iv(700, 760, "eco")]),
    ).toEqual([iv(360, 700), iv(700, 760, "eco")]);
  });
  it("cuts ranges out of pieces", () => {
    expect(
      subtract(
        [[0, 600]],
        [
          [100, 200],
          [500, 700],
        ],
      ),
    ).toEqual([
      [0, 100],
      [200, 500],
    ]);
    expect(subtract([[0, 100]], [[0, 100]])).toEqual([]);
  });
});

describe("rowSegments (week grid incl. midnight)", () => {
  const workday: DayType = {
    id: "workday",
    name: "Werktag",
    days: ["mon", "tue", "wed", "thu", "fri"],
    blocks: [b("06:00", "08:00"), b("22:00", "02:00")],
  };
  const weekend: DayType = {
    id: "weekend",
    name: "WE",
    days: ["sat", "sun"],
    blocks: [b("01:00", "03:00", "away")],
  };

  it("draws own blocks clipped at midnight and the spill of the previous day", () => {
    const segs = rowSegments(workday, workday);
    expect(segs.map((s) => [s.left, s.width, s.spill, s.label])).toEqual([
      [0, (2 / 24) * 100, true, "22:00–02:00"],
      [25, (2 / 24) * 100, false, "06:00–08:00"],
      [(22 / 24) * 100, (2 / 24) * 100, false, "22:00–02:00"],
    ]);
  });
  it("today's blocks win over yesterday's spill", () => {
    const segs = rowSegments(weekend, workday);
    expect(segs.map((s) => [s.dayType, s.left, s.width])).toEqual([
      ["workday", 0, (1 / 24) * 100],
      ["weekend", (1 / 24) * 100, (2 / 24) * 100],
    ]);
  });
  it("handles missing day types (gaps)", () => {
    expect(rowSegments(undefined, undefined)).toEqual([]);
    expect(rowSegments(undefined, workday)).toHaveLength(1);
  });
});
