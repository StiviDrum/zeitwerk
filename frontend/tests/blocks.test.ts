import { describe, expect, it } from "vitest";
import {
  blockAt,
  freeUntil,
  insertBlock,
  normalize,
  removeBlock,
  replaceBlock,
  rowSegments,
  toInterval,
  fromInterval,
} from "../src/blocks";
import type { Block, DayType } from "../src/types";

const b = (start: string, end: string, profile = "comfort"): Block => ({ start, end, profile });

describe("interval conversion", () => {
  it("handles normal, 24:00 and midnight blocks", () => {
    expect(toInterval(b("16:00", "22:00"))).toEqual({ start: 960, end: 1320, profile: "comfort" });
    expect(toInterval(b("09:00", "24:00")).end).toBe(1440);
    expect(toInterval(b("22:00", "06:00"))).toEqual({ start: 1320, end: 1800, profile: "comfort" });
    expect(toInterval(b("00:00", "00:00")).end).toBe(1440);
  });
  it("round-trips", () => {
    for (const block of [b("16:00", "22:00"), b("22:00", "06:00"), b("09:00", "24:00")]) {
      expect(fromInterval(toInterval(block))).toEqual(block);
    }
  });
});

describe("insertBlock (overlap handling)", () => {
  it("adds a block into free space, sorted", () => {
    expect(insertBlock([b("16:00", "22:00")], b("06:00", "08:00"), "eco")).toEqual([
      b("06:00", "08:00"),
      b("16:00", "22:00"),
    ]);
  });
  it("splits a block that contains the new one", () => {
    expect(insertBlock([b("06:00", "22:00")], b("12:00", "13:00", "away"), "eco")).toEqual([
      b("06:00", "12:00"),
      b("12:00", "13:00", "away"),
      b("13:00", "22:00"),
    ]);
  });
  it("trims blocks overlapping at the edges and removes covered ones", () => {
    const blocks = [b("06:00", "08:00"), b("09:00", "10:00", "away"), b("11:00", "14:00")];
    expect(insertBlock(blocks, b("07:00", "12:00", "away"), "eco")).toEqual([
      b("06:00", "07:00"),
      b("07:00", "12:00", "away"),
      b("12:00", "14:00"),
    ]);
  });
  it("merges touching blocks of the same profile", () => {
    expect(
      insertBlock([b("06:00", "08:00"), b("10:00", "12:00")], b("08:00", "10:00"), "eco"),
    ).toEqual([b("06:00", "12:00")]);
  });
  it("a default-profile block only clears the range", () => {
    expect(insertBlock([b("06:00", "22:00")], b("12:00", "14:00", "eco"), "eco")).toEqual([
      b("06:00", "12:00"),
      b("14:00", "22:00"),
    ]);
  });
  it("cuts a block across midnight and keeps the crossing", () => {
    expect(insertBlock([b("22:00", "06:00")], b("23:00", "23:30", "away"), "eco")).toEqual([
      b("22:00", "23:00"),
      b("23:00", "23:30", "away"),
      b("23:30", "06:00"),
    ]);
  });
  it("cuts the morning part of a block across midnight", () => {
    expect(insertBlock([b("22:00", "06:00")], b("05:00", "07:00", "away"), "eco")).toEqual([
      b("05:00", "07:00", "away"),
      b("22:00", "05:00"),
    ]);
  });
  it("new block across midnight trims both sides", () => {
    const blocks = [b("05:00", "08:00"), b("20:00", "23:00")];
    expect(insertBlock(blocks, b("22:00", "06:00", "away"), "eco")).toEqual([
      b("06:00", "08:00"),
      b("20:00", "22:00"),
      b("22:00", "06:00", "away"),
    ]);
  });
  it("cutting at midnight splits into evening and morning", () => {
    expect(insertBlock([b("22:00", "06:00")], b("23:00", "01:00", "eco"), "eco")).toEqual([
      b("01:00", "06:00"),
      b("22:00", "23:00"),
    ]);
  });
  it("merges a midnight block with the following morning block", () => {
    expect(insertBlock([b("00:00", "02:00")], b("22:00", "00:30"), "eco")).toEqual([
      b("22:00", "02:00"),
    ]);
  });
  it("does not turn an evening block into a midnight block", () => {
    expect(
      normalize([toInterval(b("00:00", "02:00")), toInterval(b("22:00", "24:00"))]).map(
        fromInterval,
      ),
    ).toEqual([b("00:00", "02:00"), b("22:00", "24:00")]);
  });
  it("a full-day block replaces everything", () => {
    expect(
      insertBlock([b("06:00", "08:00"), b("22:00", "02:00")], b("00:00", "24:00", "away"), "eco"),
    ).toEqual([b("00:00", "24:00", "away")]);
  });
});

describe("replace / remove / lookup", () => {
  const blocks = [b("06:00", "08:00"), b("18:00", "21:00")];
  it("replaces a block, trimming its neighbours", () => {
    expect(replaceBlock(blocks, 0, b("06:00", "19:00", "away"), "eco")).toEqual([
      b("06:00", "19:00", "away"),
      b("19:00", "21:00"),
    ]);
  });
  it("removes a block", () => {
    expect(removeBlock(blocks, 1)).toEqual([b("06:00", "08:00")]);
  });
  it("finds the block at a minute incl. spill", () => {
    expect(blockAt(blocks, 7 * 60)).toBe(0);
    expect(blockAt(blocks, 12 * 60)).toBe(-1);
    expect(blockAt([b("22:00", "06:00")], 60)).toBe(0);
  });
  it("free time until the next block", () => {
    expect(freeUntil(blocks, 600)).toBe(1080);
    expect(freeUntil(blocks, 1300)).toBe(1440 + 360);
    expect(freeUntil([], 600)).toBe(600 + 1440);
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
      [0, (2 / 24) * 100, true, "22–2"],
      [25, (2 / 24) * 100, false, "6–8"],
      [(22 / 24) * 100, (2 / 24) * 100, false, "22–2"],
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

describe("dragBlock / copyDayType", () => {
  it("drags edges with snapping and minimum duration", async () => {
    const { dragBlock } = await import("../src/blocks");
    expect(dragBlock(b("16:00", "22:00"), "start", -67, 15)).toEqual(b("15:00", "22:00"));
    expect(dragBlock(b("16:00", "22:00"), "end", 22, 15)).toEqual(b("16:00", "22:15"));
    expect(dragBlock(b("16:00", "22:00"), "start", 600, 15)).toEqual(b("21:45", "22:00"));
    expect(dragBlock(b("16:00", "22:00"), "end", -900, 15)).toEqual(b("16:00", "16:15"));
    expect(dragBlock(b("01:00", "03:00"), "start", -200, 15)).toEqual(b("00:00", "03:00"));
  });
  it("end may run across midnight, at most 24 h", async () => {
    const { dragBlock } = await import("../src/blocks");
    expect(dragBlock(b("22:00", "23:00"), "end", 180, 15)).toEqual(b("22:00", "02:00"));
    expect(dragBlock(b("22:00", "02:00"), "end", -180, 15)).toEqual(b("22:00", "23:00"));
    expect(dragBlock(b("22:00", "23:00"), "end", 5000, 15)).toEqual(b("22:00", "22:00"));
    expect(dragBlock(b("22:00", "02:00"), "start", -60, 15)).toEqual(b("21:00", "02:00"));
  });
  it("moves a block keeping its length", async () => {
    const { dragBlock } = await import("../src/blocks");
    expect(dragBlock(b("16:00", "22:00"), "move", 60, 15)).toEqual(b("17:00", "23:00"));
    expect(dragBlock(b("16:00", "22:00"), "move", 180, 15)).toEqual(b("19:00", "01:00"));
    expect(dragBlock(b("01:00", "03:00"), "move", -120, 15)).toEqual(b("00:00", "02:00"));
  });
  it("copies a day type", async () => {
    const { copyDayType } = await import("../src/blocks");
    const plan = {
      week: {
        day_types: [
          { id: "a", name: "A", days: [], blocks: [b("06:00", "08:00")] },
          { id: "b", name: "B", days: [], blocks: [b("09:00", "10:00")] },
          { id: "c", name: "C", days: [], blocks: [] },
        ],
      },
    } as unknown as import("../src/types").Plan;
    copyDayType(plan, "a", ["b"]);
    expect(plan.week.day_types[1].blocks).toEqual([b("06:00", "08:00")]);
    expect(plan.week.day_types[2].blocks).toEqual([]);
    plan.week.day_types[1].blocks[0].start = "05:00";
    expect(plan.week.day_types[0].blocks[0].start).toBe("06:00");
  });
});

describe("detachDay", () => {
  const plan = () =>
    ({
      week: {
        day_types: [
          {
            id: "workday",
            name: "Werktag",
            days: ["mon", "tue", "wed", "thu", "fri"],
            blocks: [b("16:00", "22:00")],
          },
          { id: "weekend", name: "WE", days: ["sat", "sun"], blocks: [] },
        ],
      },
    }) as unknown as import("../src/types").Plan;
  it("creates a single-day type with a copy of the blocks", async () => {
    const { detachDay } = await import("../src/blocks");
    const p = plan();
    expect(detachDay(p, "wed", "Mittwoch")).toBe("wed");
    expect(p.week.day_types[0].days).toEqual(["mon", "tue", "thu", "fri"]);
    expect(p.week.day_types[2]).toEqual({
      id: "wed",
      name: "Mittwoch",
      days: ["wed"],
      blocks: [b("16:00", "22:00")],
    });
    p.week.day_types[2].blocks[0].end = "23:00";
    expect(p.week.day_types[0].blocks[0].end).toBe("22:00");
  });
  it("reuses a day type that already holds only this day", async () => {
    const { detachDay } = await import("../src/blocks");
    const p = plan();
    detachDay(p, "wed", "Mittwoch");
    expect(detachDay(p, "wed", "Mittwoch")).toBe("wed");
    expect(p.week.day_types).toHaveLength(3);
  });
  it("creates a day for an unassigned weekday and avoids id clashes", async () => {
    const { detachDay } = await import("../src/blocks");
    const p = plan();
    p.week.day_types[1].days = ["sat"];
    p.week.day_types.push({ id: "sun", name: "x", days: [], blocks: [] });
    expect(detachDay(p, "sun", "Sonntag")).toBe("sun_2");
    expect(p.week.day_types[p.week.day_types.length - 1].days).toEqual(["sun"]);
  });
});
