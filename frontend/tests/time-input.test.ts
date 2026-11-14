import { describe, expect, it } from "vitest";
import { moveResumePoint, setBlockTime, type DayBlock } from "../src/day-plan";
import { parseTimeInput } from "../src/time";

const d = (start: number, end: number, profile = "comfort"): DayBlock => ({ start, end, profile });

describe("parseTimeInput", () => {
  it.each([
    ["7", 420],
    ["07", 420],
    ["730", 450],
    ["0730", 450],
    ["7:30", 450],
    ["7.30", 450],
    ["07:30", 450],
    ["7:3", 450],
    [" 22:15 ", 1335],
    ["0", 0],
    ["24", 1440],
    ["24:00", 1440],
  ])("%s -> %d", (text, minutes) => {
    expect(parseTimeInput(text)).toBe(minutes);
  });

  it.each(["", "abc", "25:00", "24:30", "7:60", "12345", "7:", ":30"])("rejects %s", (text) => {
    expect(parseTimeInput(text)).toBeNull();
  });
});

describe("setBlockTime", () => {
  const blocks = [d(360, 480), d(960, 1320)];

  it("sets start and end", () => {
    expect(setBlockTime(blocks, 1, "start", 900)).toEqual([d(360, 480), d(900, 1320)]);
    expect(setBlockTime(blocks, 1, "end", 1440)).toEqual([d(360, 480), d(960, 1440)]);
  });

  it("clamps at neighbours and keeps one minute", () => {
    expect(setBlockTime(blocks, 1, "start", 400)[1]).toEqual(d(480, 1320));
    expect(setBlockTime(blocks, 0, "end", 1000)[0]).toEqual(d(360, 960));
    expect(setBlockTime(blocks, 1, "start", 1400)[1]).toEqual(d(1319, 1320));
    expect(setBlockTime(blocks, 0, "end", 100)[0]).toEqual(d(360, 361));
  });
});

describe("moveResumePoint", () => {
  it("moves, clamps and refuses taken times", () => {
    expect(moveResumePoint([600, 780], 0, 615)).toEqual([615, 780]);
    expect(moveResumePoint([600], 0, -20)).toEqual([0]);
    expect(moveResumePoint([600], 0, 1500)).toEqual([1439]);
    expect(moveResumePoint([600, 780], 0, 780)).toBeNull();
  });
});
