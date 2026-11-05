import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS build config
import { minifyCss } from "../rollup.config.mjs";

describe("css minifier (build)", () => {
  it("drops comments and indentation but keeps meaningful spaces", () => {
    const src = "x = css`\n  /* c */\n  .a .b:hover,\n  .c {\n    margin: 0 4px;\n  }\n`;";
    expect(minifyCss(src)).toBe("x = css`.a .b:hover, .c{margin: 0 4px;}`;");
  });
  it("leaves templates with interpolations alone", () => {
    const src = "css`\n  .a { color: ${c}; }\n`";
    expect(minifyCss(src)).toBe(src);
  });
});
