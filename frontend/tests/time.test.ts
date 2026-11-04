import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTime,
  parseTime,
  shortTime,
  snap,
  wrap,
  zonedClock,
  zonedNow,
} from "../src/time";

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
  it("short labels", () => {
    expect(shortTime(960)).toBe("16");
    expect(shortTime(390)).toBe("6:30");
    expect(shortTime(0)).toBe("0");
    expect(shortTime(1440)).toBe("24");
  });
  it("snaps to the step", () => {
    expect(snap(967, 15)).toBe(960);
    expect(snap(968, 15)).toBe(975);
    expect(snap(1436, 15)).toBe(1440);
    expect(snap(7, 30)).toBe(0);
  });
  it("wraps onto the circle", () => {
    expect(wrap(-15)).toBe(1425);
    expect(wrap(1440)).toBe(0);
    expect(wrap(1500)).toBe(60);
  });
  it("formats durations", () => {
    expect(formatDuration(360)).toBe("6 h");
    expect(formatDuration(135)).toBe("2 h 15 min");
    expect(formatDuration(45)).toBe("45 min");
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
