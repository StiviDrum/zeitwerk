/**
 * Condition list editor: Home Assistant's own condition editor
 * (`ha-selector` with a `condition` selector) when it can be loaded,
 * otherwise a JSON text area.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { Condition } from "./conditions";
import type { Localizer } from "./localize";
import { tokens } from "./styles";
import type { HomeAssistant } from "./types";

declare global {
  interface Window {
    loadCardHelpers?: () => Promise<{
      createCardElement(config: Record<string, unknown>): HTMLElement;
    }>;
  }
}

let loading: Promise<boolean> | undefined;

/** Make sure `ha-selector` is defined (it is lazy-loaded by HA's card editors). */
export function ensureHaSelector(): Promise<boolean> {
  if (customElements.get("ha-selector")) return Promise.resolve(true);
  loading ??= (async () => {
    try {
      const helpers = await window.loadCardHelpers?.();
      const card = helpers?.createCardElement({ type: "tile", entity: "sun.sun" });
      const ctor = card?.constructor as { getConfigElement?: () => Promise<unknown> } | undefined;
      await ctor?.getConfigElement?.();
    } catch {
      // ignore – fallback below
    }
    await Promise.race([
      customElements.whenDefined("ha-selector"),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    return !!customElements.get("ha-selector");
  })();
  return loading;
}

export class ZeitwerkConditionsEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public value: Condition[] = [];
  @state() private _native?: boolean;
  @state() private _text = "";
  @state() private _jsonError?: string;

  public connectedCallback(): void {
    super.connectedCallback();
    if (this._native === undefined) {
      ensureHaSelector().then((ok) => (this._native = ok));
    }
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("value") && !this._jsonError) {
      this._text = JSON.stringify(this.value ?? [], null, 2);
    }
  }

  private _emit(value: Condition[]): void {
    this.value = value;
    this.dispatchEvent(new CustomEvent("value-changed", { detail: { value } }));
  }

  private _onSelector(ev: CustomEvent<{ value: Condition[] | undefined }>): void {
    ev.stopPropagation();
    this._emit(ev.detail.value ?? []);
  }

  private _onText(ev: Event): void {
    this._text = (ev.target as HTMLTextAreaElement).value;
    try {
      const parsed: unknown = JSON.parse(this._text || "[]");
      const list = Array.isArray(parsed) ? parsed : [parsed];
      if (!list.every((c) => c && typeof c === "object" && !Array.isArray(c))) {
        throw new Error("expected a list of objects");
      }
      this._jsonError = undefined;
      this._emit(list as Condition[]);
    } catch (err) {
      this._jsonError = err instanceof Error ? err.message : String(err);
      this.dispatchEvent(new CustomEvent("value-invalid"));
    }
  }

  /** Whether the current text is valid (fallback mode). */
  public get valid(): boolean {
    return !this._jsonError;
  }

  protected render() {
    if (this._native === undefined) return html`<div class="loading">…</div>`;
    if (this._native && this.hass) {
      return html`<ha-selector
        .hass=${this.hass}
        .selector=${{ condition: {} }}
        .value=${this.value}
        @value-changed=${this._onSelector}
      ></ha-selector>`;
    }
    return html`<label>
      <span class="hint">${this.localize.t("conditions_json")}</span>
      <textarea spellcheck="false" .value=${this._text} @input=${this._onText}></textarea>
      ${
        this._jsonError
          ? html`<span class="error"
              >${this.localize.t("invalid_json", { error: this._jsonError })}</span
            >`
          : nothing
      }
    </label>`;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .hint,
      .loading {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      textarea {
        min-height: 140px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        padding: 10px;
        border-radius: 12px;
        border: 1px solid var(--zw-border);
        background: var(--zw-surface);
        color: var(--zw-text);
        resize: vertical;
      }
      .error {
        font-size: 12px;
        color: var(--zw-danger);
      }
    `,
  ];
}
