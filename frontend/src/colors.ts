import type { Plan, Profile } from "./types";

/** Defaults for profiles without a colour (DESIGN.md §1). */
export const PALETTE = [
  "#ff8b4a",
  "#6fa8ff",
  "#aeaeb8",
  "#c79bff",
  "#4ad295",
  "#ffc94a",
  "#ff7aa8",
];

export function profileColor(plan: Plan, profile: Profile | string | null | undefined): string {
  const p =
    typeof profile === "string" || !profile ? plan.profiles.find((x) => x.id === profile) : profile;
  if (!p) return "#aeaeb8";
  if (p.color) return p.color;
  return PALETTE[Math.max(0, plan.profiles.indexOf(p)) % PALETTE.length];
}

/** `color` at `percent` % opacity (works for any CSS colour). */
export function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Near-black text on light profile colours, white on dark ones (≥ 4.5:1 where possible). */
export function textOn(color: string): string {
  const lum = luminance(color);
  if (lum === null) return "#1b1b1f";
  const dark = 0.012; // ~#1b1b1f
  return contrast(lum, dark) >= contrast(lum, 1) ? "#1b1b1f" : "#ffffff";
}
