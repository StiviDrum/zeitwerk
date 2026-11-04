import { describe, expect, it } from "vitest";
import {
  addBlock,
  applyDayPlan,
  daysToWeek,
  dragDayBlock,
  fromDayBlocks,
  gapAt,
  toDayBlocks,
  weekToDays,
  type DayBlock,
} from "../src/day-plan";
import { localizer } from "../src/localize";
import type { Block, Plan } from "../src/types";

const de = localizer("de");
const b = (start: string, end: string, profile = "comfort"): Block => ({ start, end, profile });
const d = (start: number, end: number, profile = "comfort"): DayBlock => ({ start, end, profile });

const plan = (dayTypes: Plan["week"]["day_types"], holidays?: Partial<Plan["holidays"]>): Plan =>
  ({
    week: { day_types: dayTypes },
    holidays: { source: null, mode: "off", like_day: null, day_type: null, ...holidays },
  }) as unknown as Plan;

const reference = () =>
  plan([
    {
      id: "workday",
      name: "Werktag",
      days: ["mon", "tue", "wed", "thu", "fri"],
      blocks: [b("16:00", "22:00")],
    },
    { id: "weekend", name: "Wochenende", days: ["sat", "sun"], blocks: [b("09:00", "22:00")] },
  ]);

describe("weekToDays", () => {
  it("expands day types to weekdays", () => {
    const days = weekToDays(reference());
    expect(days.mon).toEqual([b("16:00", "22:00")]);
    expect(days.sun).toEqual([b("09:00", "22:00")]);
    expect(days.holiday).toEqual([]);
  });
  it("splits blocks across midnight into evening and next morning", () => {
    const p = plan([
      {
        id: "all",
        name: "Alle",
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        blocks: [],
      },
    ]);
    p.week.day_types = [
      { id: "mon", name: "Mo", days: ["mon"], blocks: [b("22:00", "06:00")] },
      { id: "tue", name: "Di", days: ["tue"], blocks: [b("05:00", "07:00", "away")] },
      { id: "rest", name: "Rest", days: ["wed", "thu", "fri", "sat", "sun"], blocks: [] },
    ];
    const days = weekToDays(p);
    expect(days.mon).toEqual([b("22:00", "24:00")]);
    // today's block wins over yesterday's spill
    expect(days.tue).toEqual([b("00:00", "05:00"), b("05:00", "07:00", "away")]);
  });
  it("own holiday day type is clipped at midnight", () => {
    const p = reference();
    p.week.day_types.push({
      id: "holiday",
      name: "Feiertag",
      days: [],
      blocks: [b("20:00", "02:00")],
    });
    p.holidays = {
      source: "calendar.x",
      mode: "own_day_type",
      like_day: null,
      day_type: "holiday",
    };
    expect(weekToDays(p).holiday).toEqual([b("20:00", "24:00")]);
  });
});

describe("daysToWeek / applyDayPlan", () => {
  it("keeps existing day types when nothing changed", () => {
    const p = reference();
    expect(daysToWeek(p, weekToDays(p), de)).toEqual(p.week.day_types);
  });
  it("one day differs -> own day type named after the day", () => {
    const p = reference();
    applyDayPlan(p, ["wed"], [b("06:00", "08:00"), b("16:00", "22:00")], de);
    expect(p.week.day_types.map((t) => [t.id, t.name, t.days.join(",")])).toEqual([
      ["mon_tue_thu_fri", "Mo, Di, Do, Fr", "mon,tue,thu,fri"],
      ["wed", "Mi", "wed"],
      ["weekend", "Wochenende", "sat,sun"],
    ]);
  });
  it("applying the same plan to other days regroups them", () => {
    const p = reference();
    applyDayPlan(p, ["sat", "sun", "mon", "tue", "wed", "thu", "fri"], [b("06:00", "22:00")], de);
    expect(p.week.day_types).toEqual([
      {
        id: "mon_tue_wed_thu_fri_sat_sun",
        name: "Mo–So",
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        blocks: [b("06:00", "22:00")],
      },
    ]);
  });
  it("replaces the blocks of the target days completely", () => {
    const p = reference();
    applyDayPlan(p, ["sat"], [], de);
    const days = weekToDays(p);
    expect(days.sat).toEqual([]);
    expect(days.sun).toEqual([b("09:00", "22:00")]);
  });
  it("keeps the holiday day type separate", () => {
    const p = reference();
    p.week.day_types.push({ id: "holiday", name: "Feiertag", days: [], blocks: [] });
    p.holidays = {
      source: "calendar.x",
      mode: "own_day_type",
      like_day: null,
      day_type: "holiday",
    };
    applyDayPlan(p, ["holiday", "sun"], [b("08:00", "23:00")], de);
    const holiday = p.week.day_types.find((t) => t.id === "holiday")!;
    expect(holiday).toEqual({
      id: "holiday",
      name: "Feiertag",
      days: [],
      blocks: [b("08:00", "23:00")],
    });
    expect(weekToDays(p).sun).toEqual([b("08:00", "23:00")]);
  });
});

describe("day editing", () => {
  it("converts and merges", () => {
    expect(toDayBlocks([b("16:00", "24:00"), b("06:00", "08:00")])).toEqual([
      d(360, 480),
      d(960, 1440),
    ]);
    expect(fromDayBlocks([d(360, 480), d(480, 600), d(700, 700)])).toEqual([b("06:00", "10:00")]);
  });
  it("finds gaps", () => {
    const blocks = [d(360, 480), d(960, 1320)];
    expect(gapAt(blocks, 600)).toEqual([480, 960]);
    expect(gapAt(blocks, 400)).toBeNull();
    expect(gapAt(blocks, 1400)).toEqual([1320, 1440]);
    expect(gapAt([], 10)).toEqual([0, 1440]);
  });
  it("adds blocks at a position or in the first free gap", () => {
    expect(addBlock([], "comfort", 15)).toEqual({ blocks: [d(360, 480)], index: 0 });
    expect(addBlock([d(360, 480)], "away", 15, 500)).toEqual({
      blocks: [d(360, 480), d(495, 615, "away")],
      index: 1,
    });
    // at a position close to the next block: shortened
    expect(addBlock([d(600, 700)], "x", 15, 560)?.blocks[0]).toEqual(d(555, 600, "x"));
    // 06:00 taken -> after the block
    expect(addBlock([d(360, 480)], "x", 15)?.blocks[1]).toEqual(d(480, 600, "x"));
    expect(addBlock([d(0, 1440)], "x", 15)).toBeNull();
    expect(addBlock([d(0, 1440)], "x", 15, 300)).toBeNull();
  });
  it("drags edges and blocks, stopping at neighbours and the day bounds", () => {
    const blocks = [d(360, 480), d(960, 1320)];
    expect(dragDayBlock(blocks, 0, "end", 100, 15)[0]).toEqual(d(360, 585));
    expect(dragDayBlock(blocks, 0, "end", 1000, 15)[0]).toEqual(d(360, 960));
    expect(dragDayBlock(blocks, 1, "start", -1000, 15)[1]).toEqual(d(480, 1320));
    expect(dragDayBlock(blocks, 1, "end", 500, 15)[1]).toEqual(d(960, 1440));
    expect(dragDayBlock(blocks, 0, "start", 500, 15)[0]).toEqual(d(465, 480));
    expect(dragDayBlock(blocks, 0, "move", -1000, 15)[0]).toEqual(d(0, 120));
    expect(dragDayBlock(blocks, 0, "move", 1000, 15)[0]).toEqual(d(840, 960));
  });
});
