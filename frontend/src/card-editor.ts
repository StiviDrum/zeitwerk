/** Visual editor for the card configuration (getConfigElement). */
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ensureHaSelector } from "./conditions-editor";
import { localizer } from "./localize";
import type { HomeAssistant, Plan, ZeitwerkCardConfig } from "./types";

type Schema = { name: keyof ZeitwerkCardConfig; selector: Record<string, unknown> }[];

export class ZeitwerkCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: ZeitwerkCardConfig;
  @state() private _plans?: Plan[];
  @state() private _native = false;
  private _loading = false;

  public setConfig(config: ZeitwerkCardConfig): void {
    this._config = config;
  }

  public connectedCallback(): void {
    super.connectedCallback();
    ensureHaSelector().then(() => (this._native = !!customElements.get("ha-form")));
  }

  protected willUpdate(): void {
    if (this.hass && this._plans === undefined && !this._loading) {
      this._loading = true;
      this.hass
        .callWS<{ plans: Plan[] }>({ type: "zeitwerk/plans/list" })
        .then((r) => (this._plans = r.plans))
        .catch(() => (this._plans = []));
    }
  }

  private get _l() {
    return localizer(this.hass?.locale?.language ?? this.hass?.language);
  }

  private _schema(): Schema {
    const l = this._l;
    const view = this._config?.view ?? "week";
    const plans = this._plans ?? [];
    const tags = [...new Set(plans.flatMap((p) => p.tags))].sort();
    const viewSel = {
      select: {
        mode: "dropdown",
        options: [
          { value: "week", label: l.t("ed_view_week") },
          { value: "timeline", label: l.t("ed_view_timeline") },
        ],
      },
    };
    if (view === "timeline") {
      return [
        { name: "view", selector: viewSel },
        {
          name: "tags",
          selector: { select: { multiple: true, custom_value: true, options: tags } },
        },
        { name: "title", selector: { text: {} } },
      ];
    }
    return [
      { name: "view", selector: viewSel },
      {
        name: "plan",
        selector: {
          select: {
            mode: "dropdown",
            custom_value: true,
            options: plans.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })),
          },
        },
      },
      { name: "show_profile_sliders", selector: { boolean: {} } },
      { name: "compact", selector: { boolean: {} } },
      { name: "time_step", selector: { number: { min: 5, max: 60, step: 5, mode: "box" } } },
    ];
  }

  private _label = (field: { name: string }): string => {
    const keys: Record<string, Parameters<ReturnType<typeof localizer>["t"]>[0]> = {
      view: "ed_view",
      plan: "ed_plan",
      tags: "ed_tags",
      title: "ed_title",
      show_profile_sliders: "ed_sliders",
      compact: "ed_compact",
      time_step: "ed_step",
    };
    const key = keys[field.name];
    return key ? this._l.t(key) : field.name;
  };

  private _changed(config: ZeitwerkCardConfig): void {
    const clean: Record<string, unknown> = { ...config };
    for (const [k, v] of Object.entries(clean)) {
      if (v === "" || v === undefined || (Array.isArray(v) && !v.length)) delete clean[k];
    }
    if (clean.view === "timeline") {
      for (const k of ["plan", "show_profile_sliders", "compact", "time_step"]) delete clean[k];
    } else {
      for (const k of ["tags", "title"]) delete clean[k];
    }
    clean.type = config.type ?? "custom:zeitwerk-card";
    this._config = clean as unknown as ZeitwerkCardConfig;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: clean },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected render() {
    if (!this._config) return nothing;
    const data = {
      view: "week",
      show_profile_sliders: true,
      compact: false,
      time_step: 15,
      ...this._config,
    };
    if (this._native && this.hass) {
      return html`<ha-form
        .hass=${this.hass}
        .data=${data}
        .schema=${this._schema()}
        .computeLabel=${this._label}
        @value-changed=${(ev: CustomEvent<{ value: ZeitwerkCardConfig }>) => this._changed(ev.detail.value)}
      ></ha-form>`;
    }
    // Fallback without HA's form elements.
    const l = this._l;
    const set = (changes: Partial<ZeitwerkCardConfig>) =>
      this._changed({ ...this._config!, ...changes });
    return html`<div class="form">
      <label
        >${l.t("ed_view")}
        <select
          @change=${(ev: Event) => set({ view: (ev.target as HTMLSelectElement).value as "week" })}
        >
          <option value="week" ?selected=${data.view === "week"}>${l.t("ed_view_week")}</option>
          <option value="timeline" ?selected=${data.view === "timeline"}>
            ${l.t("ed_view_timeline")}
          </option>
        </select>
      </label>
      ${
        data.view === "timeline"
          ? html`<label
              >${l.t("ed_tags")}
              <input
                .value=${(data.tags ?? []).join(", ")}
                @change=${(ev: Event) =>
                  set({
                    tags: (ev.target as HTMLInputElement).value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })}
            /></label>`
          : html`<label
              >${l.t("ed_plan")}
              <select
                @change=${(ev: Event) => set({ plan: (ev.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${!data.plan}>–</option>
                ${(this._plans ?? []).map(
                  (p) =>
                    html`<option value=${p.id} ?selected=${p.id === data.plan}>${p.name}</option>`,
                )}
              </select>
            </label>`
      }
    </div>`;
  }

  static styles = css`
    .form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-card-editor": ZeitwerkCardEditor;
  }
}
