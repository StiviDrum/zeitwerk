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

/** Shared layout of the in-card pages (configuration, profiles, wizard, day editor). */
export const pageStyles = css`
  .separator {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 24px;
    margin-top: 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .separator .line {
    flex: 1;
    height: 1px;
    background: var(--zw-border);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .between {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .segmented {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 18px;
    background: var(--zw-surface);
  }
  .switch[aria-checked="true"] {
    background: var(--zw-accent);
    justify-content: flex-end;
  }
  .switch[aria-checked="true"] span {
    background: var(--zw-on-accent);
  }
  .danger-fill {
    background: var(--zw-danger) !important;
    color: #fff;
    font-weight: 700;
  }
  .error {
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--zw-danger) 14%, transparent);
    color: var(--zw-danger);
  }
  .actions {
    display: flex;
    gap: 10px;
  }
  .danger {
    flex: 1;
    border: 1px solid color-mix(in srgb, var(--zw-danger) 55%, transparent) !important;
    color: var(--zw-danger);
    font-weight: 600;
  }
  .primary {
    flex: 2;
    background: var(--zw-accent) !important;
    color: var(--zw-on-accent);
    font-weight: 700;
  }
  .unit {
    font-size: 12px;
    color: var(--zw-text-2);
  }
  .mini {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 16px;
    background: var(--zw-surface-2);
    font-size: 18px;
  }
`;
