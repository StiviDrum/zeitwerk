/**
 * Plan creation wizard (in-card page): name, icon, tags, the profiles (same
 * editor as the profiles page: one entity for all or own entities per
 * profile) and the initial day types. Creates the plan via
 * zeitwerk/plans/create – or copies an existing plan as template.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { Localizer } from "./localize";
import type { ZeitwerkProfiles } from "./profiles-page";
import { pageStyles, tokens } from "./styles";
import type { HomeAssistant, Plan } from "./types";
import { defaultWindowProfile, withRoom } from "./rooms";
import { buildPlan, draftErrors, seedProfiles, type WizardDraft } from "./wizard";

export class ZeitwerkPlanWizard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public localize!: Localizer;
  /** Plan id to use (e.g. the card's configured but missing plan). */
  @property({ attribute: false }) public presetId?: string;
  /** Room the new plan belongs to (route `?room=`); asks for the window profile. */
  @property({ attribute: false }) public roomId?: string;
  @property({ attribute: false }) public roomName?: string;
  /** Embedded in the panel: the panel toolbar replaces the back header. */
  @property({ type: Boolean }) public hideHead = false;
  /** Chosen window profile; undefined = not touched (suggestion applies). */
  @state() private _windowProfile?: string;
  @state() private _confirmBack = false;

  @state() private _draft?: WizardDraft;
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _seed?: Plan;
  /** Existing plans that can be copied instead of starting empty. */
  @state() private _templates: { id: string; name: string }[] = [];
  @state() private _template = "";
  @state() private _copyName = "";

  public connectedCallback(): void {
    super.connectedCallback();
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
      let created = await this.hass!.callWS<Plan>({
        type: "zeitwerk/plans/duplicate",
        plan_id: this._template,
        name,
      });
      if (this.roomId) {
        // A copy for a room belongs to that room (with the suggested window reaction).
        const assigned = withRoom(created, this.roomId, defaultWindowProfile(created.profiles));
        created = await this.hass!.callWS<Plan>({
          type: "zeitwerk/plans/update",
          plan_id: created.id,
          plan: assigned,
        });
      }
      this.dispatchEvent(
        new CustomEvent("zw-created", {
          detail: { id: created.id, name: created.name, plan: created },
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

  /** Room plans: which profile applies while a window is open (suggestion: off/frost/aus). */
  private _windowField() {
    if (!this.roomId) return nothing;
    const t = this.localize.t.bind(this.localize);
    const editor = this.renderRoot.querySelector<ZeitwerkProfiles>("zeitwerk-profiles");
    const profiles = editor?.draftProfiles() ?? [];
    const suggestion = defaultWindowProfile(profiles);
    const current = this._windowProfile ?? suggestion;
    const selected = profiles.some((p) => p.id === current) ? current : "";
    return html`<div class="panel">
      <span class="muted">${t("wizard_room", { room: this.roomName ?? this.roomId })}</span>
      <label class="field">
        <span class="label">${t("wizard_window_profile")}</span>
        <select
          @change=${(ev: Event) => (this._windowProfile = (ev.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${selected === ""}>${t("room_ignore")}</option>
          ${profiles.map(
            (p) => html`<option value=${p.id} ?selected=${p.id === selected}>${p.name}</option>`,
          )}
        </select>
      </label>
    </div>`;
  }

  private get _dirty(): boolean {
    const d = this._draft;
    const editor = this.renderRoot?.querySelector<ZeitwerkProfiles>("zeitwerk-profiles");
    return !!(d?.name.trim() || d?.tags.some((x) => x.trim()) || editor?.dirty);
  }

  /** Cancel (toolbar back): with entered data the first call asks for confirmation. */
  public requestBack(): void {
    if (this._dirty && !this._confirmBack) {
      this._confirmBack = true;
      return;
    }
    this.dispatchEvent(new CustomEvent("zw-cancel", { bubbles: true, composed: true }));
  }

  /** The profile list lives in a child element: re-render the dependent select after edits. */
  private _refreshTimer?: number;
  private _refresh = (): void => {
    window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => this.requestUpdate(), 0);
  };

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this._refreshTimer);
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

  protected firstUpdated(): void {
    this._refresh();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!this._draft && this.localize) {
      const t = this.localize.t.bind(this.localize);
      this._draft = { name: "", id: this.presetId, icon: "mdi:radiator", tags: [], layout: "week" };
      // Seed for the embedded profiles editor (nothing switched yet).
      const profiles = seedProfiles([t("profile_comfort"), t("profile_eco"), t("profile_away")]);
      this._seed = {
        id: "",
        name: "",
        enabled: true,
        icon: null,
        tags: [],
        profiles,
        default_profile: profiles[1].id,
        activation: { match: "all", conditions: [], when_inactive: "none", reevaluate: true },
        holidays: { source: null, mode: "off", like_day: null, day_type: null },
        week: { day_types: [] },
        overrides: [],
        options: {},
      };
    }
    void changed;
  }

  /** Suggest the entity's name as plan name while the name is still empty. */
  private _onEntity = (ev: CustomEvent<{ entityId: string }>): void => {
    const friendly = this.hass?.states[ev.detail.entityId]?.attributes.friendly_name;
    if (!this._draft!.name && typeof friendly === "string") this._update({ name: friendly });
  };

  private _update(changes: Partial<WizardDraft>): void {
    this._draft = { ...this._draft!, ...changes };
    this._error = undefined;
  }

  private async _create(): Promise<void> {
    const t = this.localize.t.bind(this.localize);
    const d = this._draft!;
    const editor = this.renderRoot.querySelector<ZeitwerkProfiles>("zeitwerk-profiles");
    const result = editor?.result();
    const errors = [...draftErrors(d).map((e) => t(e)), ...(result?.error ? [result.error] : [])];
    if (errors.length || !result) {
      this._error = errors.join(" ");
      return;
    }
    const plan = buildPlan(
      {
        ...d,
        room: this.roomId,
        windowProfile: this._windowProfile ?? defaultWindowProfile(result.profiles),
      },
      result.profiles,
      result.defaultId,
      { workday: t("workday"), weekend: t("weekend"), daily: t("daily") },
    );
    this._busy = true;
    try {
      const created = await this.hass!.callWS<Plan>({
        type: "zeitwerk/plans/create",
        plan,
      });
      this.dispatchEvent(
        new CustomEvent("zw-created", {
          detail: { id: created.id, name: created.name, plan: created },
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

  protected render() {
    if (!this._draft || !this.localize) return nothing;
    const t = this.localize.t.bind(this.localize);
    const back = () =>
      this.dispatchEvent(new CustomEvent("zw-cancel", { bubbles: true, composed: true }));
    return html`
      ${
        this.hideHead
          ? nothing
          : html`
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
            `
      }
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

      <zeitwerk-profiles
        embedded
        ?dark=${this.hasAttribute("dark")}
        .hass=${this.hass}
        .plan=${this._seed}
        .localize=${this.localize}
        @zw-entity-changed=${this._onEntity}
        @input=${this._refresh}
        @change=${this._refresh}
        @click=${this._refresh}
      ></zeitwerk-profiles>

      <div class="panel">
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
      ${this._windowField()}
      ${
        this._confirmBack
          ? html`<div class="confirm-box" role="alert">
              <span>${t("discard_changes")}</span>
              <div class="actions">
                <button class="secondary grow" @click=${() => (this._confirmBack = false)}>
                  ${t("cancel")}
                </button>
                <button class="danger-fill grow" @click=${() => this.requestBack()}>
                  ${t("discard")}
                </button>
              </div>
            </div>`
          : nothing
      }
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
      .confirm-box {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--zw-danger) 12%, transparent);
        font-size: 14px;
      }
      .confirm-box .actions button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
      }
      .secondary {
        background: var(--zw-surface-2);
        color: var(--zw-text);
        font-weight: 600;
      }
      .grow {
        flex: 1;
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
