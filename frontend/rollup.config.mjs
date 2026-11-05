import { readFileSync } from "node:fs";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

/**
 * Minify the static css`` blocks of the components (terser keeps template
 * literals verbatim). The blocks contain no ${} interpolations.
 */
export function minifyCss(code) {
  return code.replace(/\bcss\s*`([^`$]*)`/g, (_, body) => {
    const min = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([{};])\s*/g, "$1")
      .trim();
    return `css\`${min}\``;
  });
}

const minifyCssPlugin = {
  name: "minify-css",
  transform(code, id) {
    return id.endsWith(".ts") ? { code: minifyCss(code), map: null } : null;
  },
};
const dev = !!process.env.ROLLUP_WATCH;

export default {
  input: "src/zeitwerk-card.ts",
  output: {
    file: "../custom_components/zeitwerk/frontend/zeitwerk-card.js",
    format: "es",
    sourcemap: false,
    inlineDynamicImports: true,
  },
  plugins: [
    replace({ preventAssignment: true, values: { __VERSION__: JSON.stringify(pkg.version) } }),
    nodeResolve(),
    typescript({ tsconfig: "./tsconfig.json", include: ["src/**/*.ts"] }),
    // After TypeScript: plugin-typescript compiles from disk, not from earlier transforms.
    !dev && minifyCssPlugin,
    !dev && terser({ format: { comments: false } }),
  ],
};
