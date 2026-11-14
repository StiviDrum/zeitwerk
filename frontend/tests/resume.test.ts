import { describe, expect, it } from "vitest";
import { applyDayPlan, daysToWeek, weekToDays, weekToResume } from "../src/day-plan";
import { shiftResumePoint, suggestResumePoint } from "../src/day-editor";
import { localizer } from "../src/localize";
import type { Block, Plan } from "../src/types";

const de = localizer("de");
const b = (start: string, end: string, profile = "comfort"): Block => ({ start, end, profile });

const reference = (): Plan =>
  ({
    week: {
      day_types: [
        {
          id: "workday",
          name: "Werktag",
          days: ["mon", "tue", "wed", "thu", "fri"],
          blocks: [b("16:00", "22:00")],
          resume_points: ["13:00"],
        },
        { id: "weekend", name: "Wochenende", days: ["sat", "sun"], blocks: [b("09:00", "22:00")] },
      ],
    },
    holidays: { source: null, mode: "off", like_day: null, day_type: null },
  }) as unknown as Plan;

describe("resume points in day plans", () => {
  it("reads resume settings per day", () => {
    const r = weekToResume(reference());
    expect(r.mon).toEqual({ resume_points: ["13:00"], resume_forced: false });
    expect(r.sat).toEqual({ resume_points: [], resume_forced: false });
  });

  it("round-trips unchanged and omits empty settings", () => {
    const p = reference();
    expect(daysToWeek(p, weekToDays(p), de)).toEqual(p.week.day_types);
  });

  it("keeps other days' points when saving blocks only", () => {
    const p = reference();
    applyDayPlan(p, ["sat"], [b("08:00", "22:00")], de);
    expect(weekToResume(p).mon.resume_points).toEqual(["13:00"]);
  });

  it("splits and merges day types by resume settings", () => {
    const p = reference();
    applyDayPlan(p, ["wed"], [b("16:00", "22:00")], de, {
      resume_points: ["22:30"],
      resume_forced: true,
    });
    expect(p.week.day_types).toHaveLength(3);
    const wed = p.week.day_types.find((t) => t.days.includes("wed"))!;
    expect(wed).toMatchObject({ days: ["wed"], resume_points: ["22:30"], resume_forced: true });

    applyDayPlan(p, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], [b("16:00", "22:00")], de, {
      resume_points: ["23:00", "12:00"],
      resume_forced: false,
    });
    expect(p.week.day_types).toHaveLength(1);
    expect(p.week.day_types[0].resume_points).toEqual(["12:00", "23:00"]);
    expect(p.week.day_types[0]).not.toHaveProperty("resume_forced");
  });

  it("keeps holiday resume settings", () => {
    const p = reference();
    p.week.day_types.push({
      id: "holiday",
      name: "Feiertag",
      days: [],
      blocks: [],
      resume_points: ["10:00"],
      resume_forced: true,
    });
    p.holidays = {
      source: "calendar.x",
      mode: "own_day_type",
      like_day: null,
      day_type: "holiday",
    };
    applyDayPlan(p, ["sun"], [b("08:00", "23:00")], de);
    expect(p.week.day_types.find((t) => t.id === "holiday")).toMatchObject({
      resume_points: ["10:00"],
      resume_forced: true,
    });
  });
});

describe("resume point editing", () => {
  it("suggests the next free time", () => {
    expect(suggestResumePoint([], 22 * 60, 15)).toBe(1320);
    expect(suggestResumePoint([1320], 22 * 60, 15)).toBe(1335);
    expect(suggestResumePoint([], 23 * 60 + 55, 15)).toBe(0); // snapped 24:00 -> 00:00
  });

  it("shifts, wraps around midnight and skips taken times", () => {
    expect(shiftResumePoint([600], 0, 15, 15)).toEqual([615]);
    expect(shiftResumePoint([0], 0, -15, 15)).toEqual([1425]);
    expect(shiftResumePoint([600, 615], 0, 15, 15)).toEqual([630, 615]);
  });
});
