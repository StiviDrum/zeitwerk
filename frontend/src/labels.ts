/**
 * Staged block labels: "06:00–08:00", else "06:00", else nothing – chosen
 * from the block's real width in pixels.
 */

/** Horizontal padding a label needs inside its block (px). */
export const LABEL_PADDING = 8;

export type TextMeasure = (text: string) => number;

/** Rough width of 11px bold digits, used when canvas measuring is unavailable. */
export const estimateWidth: TextMeasure = (text) => text.length * 6.6;

let canvas: HTMLCanvasElement | undefined;

/** Measure text with a CSS font shorthand (cached canvas). */
export function canvasMeasure(font: string): TextMeasure {
  try {
    canvas ??= document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return estimateWidth;
    ctx.font = font;
    const cache = new Map<string, number>();
    return (text) => {
      let w = cache.get(text);
      if (w === undefined) {
        w = ctx.measureText(text).width;
        cache.set(text, w);
      }
      return w;
    };
  } catch {
    return estimateWidth;
  }
}

/** The longest of the candidate labels that fits into `widthPx`. */
export function fitLabel(
  candidates: readonly string[],
  widthPx: number,
  measure: TextMeasure = estimateWidth,
): string {
  for (const text of candidates) {
    if (text && measure(text) + LABEL_PADDING <= widthPx) return text;
  }
  return "";
}

/** Observe an element's width; returns a disconnect function. */
export function observeWidth(el: Element, onWidth: (px: number) => void): () => void {
  if (typeof ResizeObserver === "undefined") {
    onWidth(el.getBoundingClientRect().width);
    return () => undefined;
  }
  const ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w !== undefined) onWidth(w);
  });
  ro.observe(el);
  return () => ro.disconnect();
}
