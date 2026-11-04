import { css } from "lit";

/** Design tokens (DESIGN.md §1): HA theme variables first, mockup values as fallback. */
export const tokens = css`
  :host {
    --zw-bg: var(--ha-card-background, var(--card-background-color, #151518));
    --zw-text: var(--primary-text-color, #f5f5f7);
    --zw-text-2: var(--secondary-text-color, rgba(245, 245, 247, 0.62));
    --zw-surface: color-mix(in srgb, var(--zw-text) 7%, transparent);
    --zw-surface-2: color-mix(in srgb, var(--zw-text) 11%, transparent);
    --zw-border: var(--ha-card-border-color, var(--divider-color, rgba(255, 255, 255, 0.1)));
    --zw-accent: var(--primary-color, #03a9f4);
    --zw-on-accent: var(--text-primary-color, #ffffff);
    --zw-ok: var(--success-color, #4ad295);
    --zw-danger: var(--error-color, #ff5a6e);
    --zw-radius-card: var(--ha-card-border-radius, 26px);
    font-family: var(--ha-font-family-body, inherit);
    color: var(--zw-text);
  }
  /* Dark themes: monochrome accent like the mockup / Bubble Card. */
  :host([dark]) {
    --zw-accent: var(--primary-text-color, #f5f5f7);
    --zw-on-accent: var(--primary-background-color, #0b0b0d);
  }
  button {
    font-family: inherit;
    color: inherit;
  }
  ha-icon {
    --mdc-icon-size: 20px;
    display: inline-flex;
  }
`;
