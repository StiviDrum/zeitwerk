import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CARD_VERSION } from "./version";

interface ZeitwerkCardConfig {
  type: string;
  view?: "week" | "timeline" | "profiles";
  plan?: string;
  tags?: string[];
}

// Minimal hass shape until the real types are wired up.
interface HassLike {
  locale?: { language: string };
}

@customElement("zeitwerk-card")
export class ZeitwerkCard extends LitElement {
  @property({ attribute: false }) public hass?: HassLike;
  @state() private _config?: ZeitwerkCardConfig;

  public setConfig(config: ZeitwerkCardConfig): void {
    if (!config) throw new Error("Invalid configuration");
    this._config = { view: "week", ...config };
  }

  public getCardSize(): number {
    return 4;
  }

  public static getStubConfig(): Partial<ZeitwerkCardConfig> {
    return { view: "timeline" };
  }

  protected render() {
    if (!this._config) return nothing;
    return html`<ha-card>
      <div class="placeholder">Zeitwerk ${CARD_VERSION}</div>
    </ha-card>`;
  }

  static styles = css`
    :host {
      --zw-text: var(--primary-text-color, #f5f5f7);
    }
    .placeholder {
      padding: 16px;
      color: var(--zw-text);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-card": ZeitwerkCard;
  }
  interface Window {
    customCards?: Array<{ type: string; name: string; description: string; preview?: boolean }>;
  }
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "zeitwerk-card")) {
  window.customCards.push({
    type: "zeitwerk-card",
    name: "Zeitwerk",
    description: "Weekly schedules with profiles and overrides",
    preview: true,
  });
}

console.info(`%c ZEITWERK-CARD %c ${CARD_VERSION} `, "background:#ff8b4a;color:#1b0f07", "");
