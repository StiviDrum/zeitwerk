/** Small render helpers and styles shared by the display components (card and panel). */
import { css, html, nothing } from "lit";
import type { Localizer } from "./localize";
import { canResume, errorMessage } from "./plan-view";
import { MINUTES_PER_DAY, parseTime } from "./time";
import type { HomeAssistant, Plan } from "./types";

/** Dotted markers for resume points on a 24 h track. */
export function resumeMarks(l: Localizer, points: string[] | undefined) {
  if (!points?.length) return nothing;
  return points.map(
    (p) =>
      html`<span
        class="rp-mark"
        style="left:${(parseTime(p) / MINUTES_PER_DAY) * 100}%"
        title="${l.t("resume_point")} ${p}"
      ></span>`,
  );
}

/** Call zeitwerk.resume; resolves with the text to show as notice. */
export async function resumePlan(hass: HomeAssistant, plan: Plan, l: Localizer): Promise<string> {
  try {
    await hass.callService("zeitwerk", "resume", { plan: plan.id });
    return l.t("resumed");
  } catch (err) {
    return errorMessage(err);
  }
}

/** Switch the plan on/off via its switch entity; resolves with an error text or "". */
export async function togglePlan(hass: HomeAssistant, plan: Plan): Promise<string> {
  try {
    await hass.callService("switch", plan.enabled ? "turn_off" : "turn_on", undefined, {
      entity_id: `switch.zeitwerk_${plan.id}`,
    });
    return "";
  } catch (err) {
    return errorMessage(err);
  }
}

export function resumeButton(
  l: Localizer,
  plan: Plan,
  onResume: (ev: Event) => void,
  compact = false,
) {
  if (!canResume(plan)) return nothing;
  return html`<button
    class="resume-btn ${compact ? "compact" : ""}"
    aria-label=${l.t("resume_plan", { name: plan.name })}
    title=${l.t("resume")}
    @click=${onResume}
    @keydown=${(ev: KeyboardEvent) => ev.stopPropagation()}
  >
    <ha-icon .icon=${"mdi:play-circle-outline"}></ha-icon>${compact ? nothing : l.t("resume")}
  </button>`;
}

/** Mirror HA's dark mode onto the host (tokens.ts switches to the monochrome accent). */
export function syncDark(el: HTMLElement, hass: HomeAssistant | undefined): void {
  el.toggleAttribute("dark", !!hass?.themes?.darkMode);
}

/** Fire a bubbling `zw-notice` event (short message shown by the host). */
export function fireNotice(el: HTMLElement, text: string): void {
  if (text)
    el.dispatchEvent(new CustomEvent("zw-notice", { detail: text, bubbles: true, composed: true }));
}

export const displayStyles = css`
  button {
    cursor: pointer;
    border: 0;
    background: none;
    padding: 0;
  }
  button:focus-visible {
    outline: 2px solid var(--zw-accent);
    outline-offset: 2px;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 4px;
  }
  .rp-mark {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 0;
    margin-left: -1px;
    border-left: 2px dotted var(--zw-text);
    pointer-events: none;
    opacity: 0.75;
  }
  .resume-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 12px 0 8px;
    border: 0;
    border-radius: 16px;
    background: var(--zw-surface-2);
    color: var(--zw-text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .resume-btn ha-icon {
    --mdc-icon-size: 16px;
  }
  .resume-btn.compact {
    width: 44px;
    height: 44px;
    padding: 0;
    flex-shrink: 0;
    justify-content: center;
    border-radius: 22px;
  }
  .resume-btn.compact ha-icon {
    --mdc-icon-size: 22px;
  }
`;
