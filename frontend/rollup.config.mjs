import { readFileSync } from "node:fs";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
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
    !dev && terser({ format: { comments: false } }),
  ],
};
