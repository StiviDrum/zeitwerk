import { describe, expect, it } from "vitest";
import { formatTime, parseTime } from "../src/time";

describe("time helpers", () => {
  it("parses and formats", () => {
    expect(parseTime("16:30")).toBe(990);
    expect(parseTime("24:00")).toBe(1440);
    expect(formatTime(990)).toBe("16:30");
  });
  it("rejects invalid values", () => {
    expect(() => parseTime("24:15")).toThrow();
    expect(() => parseTime("7")).toThrow();
  });
});
