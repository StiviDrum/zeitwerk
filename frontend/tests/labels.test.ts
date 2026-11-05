import { describe, expect, it } from "vitest";
import { fitLabel, estimateWidth, LABEL_PADDING } from "../src/labels";
import { rowSegments } from "../src/blocks";

describe("staged labels", () => {
  const full = "06:00–08:00";
  it("picks the longest label that fits", () => {
    const fullPx = estimateWidth(full) + LABEL_PADDING;
    const shortPx = estimateWidth("06:00") + LABEL_PADDING;
    expect(fitLabel([full, "06:00"], fullPx)).toBe(full);
    expect(fitLabel([full, "06:00"], fullPx - 1)).toBe("06:00");
    expect(fitLabel([full, "06:00"], shortPx)).toBe("06:00");
    expect(fitLabel([full, "06:00"], shortPx - 1)).toBe("");
    expect(fitLabel([full, "06:00"], 0)).toBe("");
  });

  it("segments carry a short form (start time, end time for spills)", () => {
    const dt = {
      id: "d",
      name: "d",
      days: [],
      blocks: [{ start: "22:00", end: "06:30", profile: "c" }],
    };
    const own = rowSegments(dt, undefined);
    expect(own[0].label).toBe("22:00–06:30");
    expect(own[0].short).toBe("22:00");
    const spill = rowSegments(undefined, dt);
    expect(spill[0].short).toBe("–06:30");
  });
});
