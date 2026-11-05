import { describe, expect, it } from "vitest";
import { formatTime, parseTime, zonedClock, zonedNow } from "../src/time";

describe("time helpers", () => {
  it("parses and formats", () => {
    expect(parseTime("16:30")).toBe(990);
    expect(parseTime("24:00")).toBe(1440);
    expect(formatTime(990)).toBe("16:30");
    expect(formatTime(1440)).toBe("24:00");
  });
  it("rejects invalid values", () => {
    expect(() => parseTime("24:15")).toThrow();
    expect(() => parseTime("7")).toThrow();
  });
  it("uses the server time zone incl. DST", () => {
    // 2026-03-29 01:30 UTC = 03:30 CEST (after the spring switch), Sunday
    const now = zonedNow("Europe/Berlin", new Date("2026-03-29T01:30:00Z"));
    expect(now).toEqual({ weekday: "sun", weekdayIndex: 6, minutes: 210 });
    // 2026-10-25 00:30 UTC = 02:30 CEST (first pass of the repeated hour)
    expect(zonedClock("2026-10-25T00:30:00Z", "Europe/Berlin")).toBe("02:30");
    expect(zonedClock("2026-10-25T01:30:00Z", "Europe/Berlin")).toBe("02:30");
    expect(zonedNow("Europe/Berlin", new Date("2026-11-04T23:30:00Z")).weekday).toBe("thu");
  });
});

describe("minutesFromToday", () => {
  it("counts across days in the server zone", async () => {
    const { minutesFromToday } = await import("../src/time");
    const now = new Date("2026-11-04T16:40:00Z"); // Wed 17:40 Berlin
    expect(minutesFromToday("2026-11-04T21:00:00Z", "Europe/Berlin", now)).toBe(22 * 60);
    expect(minutesFromToday("2026-11-05T05:00:00Z", "Europe/Berlin", now)).toBe(1440 + 6 * 60);
    expect(minutesFromToday("2026-11-03T22:30:00Z", "Europe/Berlin", now)).toBe(-30);
  });
});
