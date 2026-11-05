/**
 * Plan creation wizard (in-card page): name, icon, target entity, profiles
 * with values, initial day types. Creates the plan via zeitwerk/plans/create.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ensureHaSelector } from "./conditions-editor";
import type { Localizer } from "./localize";
import { stepDecimals } from "./quickview";
import { pageStyles, tokens } from "./styles";
import type { HomeAssistant } from "./types";
import { PALETTE } from "./colors";
import { MAX_PROFILES } from "./profile-actions";
import {
  buildPlan,
  defaultProfiles,
  draftErrors,
  targetKind,
  type TargetKind,
  type WizardDraft,
  type WizardProfile,
} from "./wizard";

const TARGET_DOMAINS = [
  "input_number",
  "number",
  "climate",
  "input_select",
  "select",
  "light",
  "cover",
  "fan",
  "switch",
  "input_boolean",
];

export class ZeitwerkPlanWizard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public localize!: Localizer;
  /** Plan id to use (e.g. the card's configured but missing plan). */
  @property({ attribute: false }) public presetId?: string;

  @state() private _draft?: WizardDraft;
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _native = false;
  /** Existing plans that can be copied instead of starting empty. */
  @state() private _templates: { id: string; name: string }[] = [];
  @state() private _template = "";
  @state() private _copyName = "";

  public connectedCallback(): void {
    super.connectedCallback();
    ensureHaSelector().then((ok) => (this._native = ok));
    this.hass
      ?.callWS<{ plans: { id: string; name: string }[] }>({ type: "zeitwerk/plans/list" })
      .then((r) => (this._templates = r.plans.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }

  private async _copy(): Promise<void> {
    const t = this.localize.t.bind(this.localize);
    const name = this._copyName.trim();
    if (!name) {
      this._error = t("name_required");
      return;
    }
    this._busy = true;
    try {
      const created = await this.hass!.callWS<{ id: string; name: string }>({
        type: "zeitwerk/plans/duplicate",
        plan_id: this._template,
        name,
      });
      this.dispatchEvent(
        new CustomEvent("zw-created", {
          detail: { id: created.id, name: created.name },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      this._error = t("save_failed", { error: msg });
    } finally {
      this._busy = false;
    }
  }

  private _templateField() {
    if (!this._templates.length) return nothing;
    const t = this.localize.t.bind(this.localize);
    return html`<label class="field">
      <span class="label">${t("wizard_template")}</span>
      <select
        @change=${(ev: Event) => {
          this._template = (ev.target as HTMLSelectElement).value;
          const tpl = this._templates.find((x) => x.id === this._template);
          this._copyName = tpl ? `${tpl.name} (${t("copy_suffix")})` : "";
          this._error = undefined;
        }}
      >
        <option value="" ?selected=${!this._template}>${t("wizard_template_empty")}</option>
        ${this._templates.map(
          (p) =>
            html`<option value=${p.id} ?selected=${p.id === this._template}>${p.name}</option>`,
        )}
      </select>
    </label>`;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!this._draft && this.localize) {
      const t = this.localize.t.bind(this.localize);
      this._draft = {
        name: "",
        id: this.presetId,
        icon: "mdi:radiator",
        tags: [],
        entityId: "",
        profiles: defaultProfiles({ kind: "toggle", domain: "switch" }, [
          t("profile_comfort"),
          t("profile_eco"),
          t("profile_away"),
        ]),
        defaultIndex: 1,
        layout: "week",
      };
    }
    void changed;
  }

  private get _target(): TargetKind {
    const id = this._draft?.entityId ?? "";
    return targetKind(id, this.hass?.states[id], this.hass?.config?.unit_system?.temperature);
  }

  private _update(changes: Partial<WizardDraft>): void {
    this._draft = { ...this._draft!, ...changes };
    this._error = undefined;
  }

  private _setEntity(entityId: string): void {
    const t = this.localize.t.bind(this.localize);
    const target = targetKind(
      entityId,
      this.hass?.states[entityId],
      this.hass?.config?.unit_system?.temperature,
    );
    const names = this._draft!.profiles.map((p) => p.name);
    const fresh = defaultProfiles(target, [
      names[0] ?? t("profile_comfort"),
      names[1] ?? t("profile_eco"),
      names[2] ?? t("profile_away"),
    ]);
    const profiles = this._draft!.profiles.map((p, i) => ({
      ...p,
      value: fresh[i]?.value ?? fresh[fresh.length - 1].value,
    }));
    const friendly = this.hass?.states[entityId]?.attributes.friendly_name;
    this._update({
      entityId,
      profiles,
      name: this._draft!.name || (typeof friendly === "string" ? friendly : ""),
    });
  }

  private _setProfile(index: number, changes: Partial<WizardProfile>): void {
    const profiles = this._draft!.profiles.map((p, i) => (i === index ? { ...p, ...changes } : p));
    this._update({ profiles });
  }

  private _addProfile(): void {
    const d = this._draft!;
    if (d.profiles.length >= MAX_PROFILES) return;
    const last = d.profiles[d.profiles.length - 1];
    this._update({
      profiles: [
        ...d.profiles,
        {
          name: "",
          color: PALETTE[d.profiles.length % PALETTE.length],
          icon: "",
          value: last?.value ?? 0,
        },
      ],
    });
  }

  private _removeProfile(index: number): void {
    const d = this._draft!;
    const profiles = d.profiles.filter((_, i) => i !== index);
    const defaultIndex =
      index < d.defaultIndex ? d.defaultIndex - 1 : Math.min(d.defaultIndex, profiles.length - 1);
    this._update({ profiles, defaultIndex });
  }

  private async _create(): Promise<void> {
    const t = this.localize.t.bind(this.localize);
    const d = this._draft!;
    const errors = draftErrors(d);
    if (errors.length) {
      this._error = errors.map((e) => t(e)).join(" ");
      return;
    }
    const plan = buildPlan(d, this._target, {
      workday: t("workday"),
      weekend: t("weekend"),
      daily: t("daily"),
    });
    this._busy = true;
    try {
      const created = await this.hass!.callWS<{ id: string; name: string }>({
        type: "zeitwerk/plans/create",
        plan,
      });
      this.dispatchEvent(
        new CustomEvent("zw-created", {
          detail: { id: created.id, name: created.name },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      this._error = t("save_failed", { error: msg });
    } finally {
      this._busy = false;
    }
  }

  private _entityField() {
    const d = this._draft!;
    if (this._native && this.hass) {
      return html`<ha-selector
        .hass=${this.hass}
        .selector=${{ entity: { domain: TARGET_DOMAINS } }}
        .value=${d.entityId}
        @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
          ev.stopPropagation();
          this._setEntity(ev.detail.value ?? "");
        }}
      ></ha-selector>`;
    }
    const options = Object.keys(this.hass?.states ?? {})
      .filter((id) => TARGET_DOMAINS.includes(id.split(".")[0]))
      .sort();
    return html`<input
        type="text"
        list="zw-entities"
        placeholder="input_number.…"
        .value=${d.entityId}
        @change=${(ev: Event) => this._setEntity((ev.target as HTMLInputElement).value.trim())}
      />
      <datalist id="zw-entities">
        ${options.map((id) => html`<option value=${id}></option>`)}
      </datalist>`;
  }

  private _valueField(p: WizardProfile, index: number) {
    const target = this._target;
    const t = this.localize.t.bind(this.localize);
    if (target.kind === "number") {
      return html`<span class="value">
        <input
          type="number"
          aria-label=${`${p.name} ${t("value")}`}
          min=${target.min}
          max=${target.max}
          step=${target.step}
          .value=${String(p.value)}
          @change=${(ev: Event) => {
            const n = Number((ev.target as HTMLInputElement).value);
            this._setProfile(index, { value: Number(n.toFixed(stepDecimals(target.step))) });
          }}
        />${target.unit ? html`<span class="unit">${target.unit}</span>` : nothing}
      </span>`;
    }
    if (target.kind === "select") {
      return html`<select
        aria-label=${`${p.name} ${t("value")}`}
        @change=${(ev: Event) => this._setProfile(index, { value: (ev.target as HTMLSelectElement).value })}
      >
        ${target.options.map((o) => html`<option value=${o} ?selected=${o === p.value}>${o}</option>`)}
      </select>`;
    }
    return html`<button
      class="switch"
      role="switch"
      aria-label=${`${p.name} ${t("value")}`}
      aria-checked=${p.value ? "true" : "false"}
      @click=${() => this._setProfile(index, { value: !p.value })}
    >
      <span></span>
    </button>`;
  }

  protected render() {
    if (!this._draft || !this.localize) return nothing;
    const t = this.localize.t.bind(this.localize);
    const back = () =>
      this.dispatchEvent(new CustomEvent("zw-cancel", { bubbles: true, composed: true }));
    return html`
      <div class="head">
        <button class="round" aria-label=${t("back")} @click=${back}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <span class="title">${t("wizard_title")}</span>
      </div>
      ${
        this._template
          ? html`<div class="panel">
                ${this._templateField()}
                <label class="field">
                  <span class="label">${t("name")}</span>
                  <input
                    type="text"
                    .value=${this._copyName}
                    @input=${(ev: Event) => (this._copyName = (ev.target as HTMLInputElement).value)}
                  />
                </label>
                <span class="muted">${t("duplicate_hint")}</span>
              </div>
              ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
              <div class="actions">
                <button class="danger" @click=${back}>${t("cancel")}</button>
                <button class="primary" ?disabled=${this._busy} @click=${this._copy}>
                  ${t("duplicate_create")}
                </button>
              </div>`
          : this._renderNew(back)
      }
    `;
  }

  private _renderNew(back: () => void) {
    const t = this.localize.t.bind(this.localize);
    const d = this._draft!;
    return html`
      <div class="panel">
        ${this._templateField()}
        <label class="field">
          <span class="label">${t("wizard_target")}</span>
          ${this._entityField()}
          <span class="muted">${t("wizard_target_hint")}</span>
        </label>
        <label class="field">
          <span class="label">${t("name")}</span>
          <input
            type="text"
            .value=${d.name}
            @input=${(ev: Event) => this._update({ name: (ev.target as HTMLInputElement).value })}
          />
        </label>
        ${
          this.presetId
            ? html`<label class="field">
                <span class="label">${t("plan_id")}</span>
                <input
                  type="text"
                  .value=${d.id ?? ""}
                  @input=${(ev: Event) => this._update({ id: (ev.target as HTMLInputElement).value })}
                />
              </label>`
            : nothing
        }
        <div class="row2">
          <label class="field">
            <span class="label">${t("icon")}</span>
            ${
              customElements.get("ha-icon-picker") && this.hass
                ? html`<ha-icon-picker
                    .hass=${this.hass}
                    .value=${d.icon}
                    @value-changed=${(ev: CustomEvent<{ value: string }>) => {
                      ev.stopPropagation();
                      this._update({ icon: ev.detail.value });
                    }}
                  ></ha-icon-picker>`
                : html`<input
                    type="text"
                    .value=${d.icon}
                    @input=${(ev: Event) => this._update({ icon: (ev.target as HTMLInputElement).value })}
                  />`
            }
          </label>
          <label class="field">
            <span class="label">${t("tags")}</span>
            <input
              type="text"
              .value=${d.tags.join(", ")}
              @input=${(ev: Event) => this._update({ tags: (ev.target as HTMLInputElement).value.split(",") })}
            />
          </label>
        </div>
      </div>

      <div class="panel">
        <span class="label">${t("section_profiles")}</span>
        ${d.profiles.map(
          (p, i) =>
            html`<div class="prow">
              <input
                type="color"
                aria-label=${`${p.name} ${t("color")}`}
                .value=${p.color}
                @input=${(ev: Event) => this._setProfile(i, { color: (ev.target as HTMLInputElement).value })}
              />
              <input
                class="pname"
                type="text"
                aria-label=${t("name")}
                .value=${p.name}
                @input=${(ev: Event) => this._setProfile(i, { name: (ev.target as HTMLInputElement).value })}
              />
              ${this._valueField(p, i)}
              <button
                class="mini"
                aria-label=${t("remove_profile", { name: p.name })}
                ?disabled=${d.profiles.length <= 2}
                @click=${() => this._removeProfile(i)}
              >
                ×
              </button>
            </div>`,
        )}
        <button
          class="add"
          ?disabled=${d.profiles.length >= MAX_PROFILES}
          @click=${this._addProfile}
        >
          ${t("add_profile")}
        </button>
        <label class="between">
          <span class="label">${t("default_profile")}</span>
          <select
            @change=${(ev: Event) => this._update({ defaultIndex: Number((ev.target as HTMLSelectElement).value) })}
          >
            ${d.profiles.map((p, i) => html`<option value=${i} ?selected=${i === d.defaultIndex}>${p.name || "…"}</option>`)}
          </select>
        </label>
        <div class="field">
          <span class="label">${t("wizard_layout")}</span>
          <div class="segmented" role="radiogroup" aria-label=${t("wizard_layout")}>
            ${(["week", "daily"] as const).map(
              (layout) =>
                html`<button
                  role="radio"
                  aria-checked=${d.layout === layout ? "true" : "false"}
                  @click=${() => this._update({ layout })}
                >
                  ${t(layout === "week" ? "layout_week" : "layout_daily")}
                </button>`,
            )}
          </div>
        </div>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      <div class="actions">
        <button class="danger" @click=${back}>${t("cancel")}</button>
        <button class="primary" ?disabled=${this._busy} @click=${this._create}>
          ${t("create")}
        </button>
      </div>
    `;
  }

  static styles = [
    tokens,
    pageStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      button {
        cursor: pointer;
        border: 0;
        background: none;
        padding: 0;
      }
      button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      button:focus-visible,
      input:focus-visible,
      select:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .title {
        font-size: 20px;
        font-weight: 700;
      }
      .round {
        width: 44px;
        height: 44px;
        border-radius: 22px;
        background: var(--zw-surface-2);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .panel {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 14px;
        border-radius: 26px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .row2 {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .label {
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
      }
      .muted {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      input[type="text"],
      input[type="number"],
      select {
        font: inherit;
        font-size: 14px;
        color: var(--zw-text);
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        border-radius: 12px;
        padding: 8px 10px;
        min-width: 0;
        box-sizing: border-box;
      }
      input[type="text"] {
        height: 42px;
      }
      select option {
        color: initial;
      }
      .prow {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      input[type="color"] {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        border: 0;
        border-radius: 18px;
        padding: 0;
        background: none;
        cursor: pointer;
      }
      .pname {
        flex: 1;
      }
      .value {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .value input {
        width: 76px;
      }
      .add {
        height: 40px;
        border-radius: 20px;
        border: 1px dashed color-mix(in srgb, var(--zw-text) 22%, transparent);
        font-size: 13px;
      }
      .segmented button {
        flex: 1;
        height: 36px;
        border-radius: 15px;
        font-size: 12px;
        font-weight: 600;
      }
      .segmented button[aria-checked="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
      }
      .switch {
        width: 52px;
        height: 32px;
        flex-shrink: 0;
        border-radius: 16px;
        background: var(--zw-surface-2);
        padding: 3px;
        display: flex;
        justify-content: flex-start;
      }
      .switch span {
        width: 26px;
        height: 26px;
        border-radius: 13px;
        background: var(--zw-text-2);
      }
      .actions button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-plan-wizard": ZeitwerkPlanWizard;
  }
}
