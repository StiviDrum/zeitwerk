import { describe, expect, it } from "vitest";
import { zonedWhen } from "../src/time";

const SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const short = (i: number) => SHORT[i];
const TZ = "Europe/Berlin";

describe("zonedWhen", () => {
  // Friday 2026-11-13 18:00 CET
  const now = new Date("2026-11-13T17:00:00Z");

  it("shows only the time for today", () => {
    expect(zonedWhen("2026-11-13T21:00:00Z", TZ, short, now)).toBe("22:00");
    expect(zonedWhen("2026-11-13T22:59:00Z", TZ, short, now)).toBe("23:59");
  });

  it("adds the short weekday after midnight, also within 24 h", () => {
    expect(zonedWhen("2026-11-13T23:00:00Z", TZ, short, now)).toBe("Sa 00:00");
    expect(zonedWhen("2026-11-14T04:15:00Z", TZ, short, now)).toBe("Sa 05:15");
    expect(zonedWhen("2026-11-16T04:15:00Z", TZ, short, now)).toBe("Mo 05:15");
  });

  it("uses the weekday of the given time zone", () => {
    // 2026-11-15 23:30 UTC is already Monday 00:30 in Berlin
    expect(zonedWhen("2026-11-15T23:30:00Z", TZ, short, now)).toBe("Mo 00:30");
    expect(zonedWhen("2026-11-15T23:30:00Z", "UTC", short, now)).toBe("So 23:30");
  });

  it("works across month and year end", () => {
    const eve = new Date("2026-12-30T12:00:00Z");
    expect(zonedWhen("2027-01-01T06:00:00Z", TZ, short, eve)).toBe("Fr 07:00");
  });

  it("returns an empty string for invalid input", () => {
    expect(zonedWhen("nope", TZ, short, now)).toBe("");
  });
});
