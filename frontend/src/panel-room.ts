/** Room editor (panel route /room/<id> and /room/new, SPEC §10 "Raumeditor"). */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ensureHaSelector } from "./conditions-editor";
import { displayStyles, syncDark } from "./display-ui";
import type { Localizer } from "./localize";
import { linkClick, navigate, routePath } from "./nav";
import { errorMessage, overviewRow } from "./plan-view";
import {
  DELAY_PRESETS,
  applyArea,
  defaultWindowProfile,
  draftErrors,
  draftFromRoom,
  emptyDraft,
  roomPayload,
  suggestions,
  withRoom,
  withWindowReaction,
  type RoomDraft,
} from "./rooms";
import { pageStyles, tokens } from "./styles";
import type { HomeAssistant, Plan, Room } from "./types";

export interface RoomSavedDetail {
  room: Room;
  created: boolean;
}

export class ZeitwerkRoomEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public localize!: Localizer;
  /** The room to edit; undefined = new room. */
  @property({ attribute: false }) public room?: Room;
  @property({ attribute: false }) public plans: Plan[] = [];
  /** Saves a whole plan (plans/update); resolves when stored. */
  @property({ attribute: false }) public updatePlan?: (plan: Plan) => Promise<void>;
  /** Embedded in the panel: the panel toolbar replaces the back header. */
  @property({ type: Boolean }) public hideHead = false;

  @state() private _draft: RoomDraft = emptyDraft();
  @state() private _dirty = false;
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _native = false;
  @state() private _confirmDiscard = false;
  @state() private _confirmDelete = false;
  @state() private _assign = "";
  /** Link target waiting for the discard confirmation. */
  @state() private _pendingPath?: string;
  private _loadedId: string | null | undefined;

  public connectedCallback(): void {
    super.connectedCallback();
    ensureHaSelector().then((ok) => (this._native = ok));
  }

  protected willUpdate(changed: PropertyValues): void {
    syncDark(this, this.hass);
    const id = this.room?.id ?? null;
    if (changed.has("room") && this._loadedId !== id) {
      this._loadedId = id;
      this._draft = this.room ? draftFromRoom(this.room) : emptyDraft();
      this._dirty = false;
      this._error = undefined;
      this._confirmDiscard = false;
      this._confirmDelete = false;
    }
  }

  private get _l(): Localizer {
    return this.localize;
  }

  private get _admin(): boolean {
    return !!this.hass?.user?.is_admin;
  }

  private _fire<T>(type: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private _set(changes: Partial<RoomDraft>): void {
    this._draft = { ...this._draft, ...changes };
    this._dirty = true;
    this._error = undefined;
    this._confirmDiscard = false;
  }

  // --- Leaving ---------------------------------------------------------------------

  /** Cancel; with unsaved changes the first call asks for confirmation. */
  public requestClose(): void {
    if (this._dirty && !this._confirmDiscard) {
      this._confirmDiscard = true;
      return;
    }
    this._fire("zw-cancel");
  }

  /** Click handler for the editor's own links: dirty drafts ask before leaving. */
  private _link(path: string): (ev: MouseEvent) => void {
    const go = linkClick(path);
    return (ev) => {
      if (
        this._dirty &&
        !ev.defaultPrevented &&
        ev.button === 0 &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.shiftKey
      ) {
        ev.preventDefault();
        this._pendingPath = path;
        this._confirmDiscard = true;
        return;
      }
      go(ev);
    };
  }

  public get dirty(): boolean {
    return this._dirty;
  }

  // --- Save / delete -----------------------------------------------------------------

  private async _save(): Promise<void> {
    const l = this._l;
    if (!this._admin) {
      this._error = l.t("admin_only");
      return;
    }
    const errors = draftErrors(this._draft);
    if (errors.length) {
      this._error = errors.map((e) => l.t(e)).join(" ");
      return;
    }
    if (!this.hass) return;
    this._busy = true;
    this._error = undefined;
    try {
      const payload = roomPayload(this._draft);
      const saved = this.room
        ? await this.hass.callWS<Room>({
            type: "zeitwerk/rooms/update",
            room_id: this.room.id,
            room: payload,
          })
        : await this.hass.callWS<Room>({ type: "zeitwerk/rooms/create", room: payload });
      this._dirty = false;
      this._fire<RoomSavedDetail>("zw-room-saved", { room: saved, created: !this.room });
    } catch (err) {
      this._error = l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  private async _delete(): Promise<void> {
    if (!this.room || !this.hass) return;
    if (!this._admin) {
      this._error = this._l.t("admin_only");
      return;
    }
    this._busy = true;
    try {
      await this.hass.callWS({ type: "zeitwerk/rooms/delete", room_id: this.room.id });
      this._dirty = false;
      this._fire("zw-room-deleted", this.room.id);
    } catch (err) {
      this._error = this._l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  /** Change a plan of this room (reaction, assignment); errors show inline. */
  private async _savePlan(plan: Plan): Promise<void> {
    if (!this._admin) {
      this._error = this._l.t("admin_only");
      return;
    }
    this._busy = true;
    this._error = undefined;
    try {
      await this.updatePlan?.(plan);
    } catch (err) {
      this._error = this._l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  // --- Field helpers -------------------------------------------------------------------

  private _name(entityId: string): string {
    return String(this.hass?.states[entityId]?.attributes.friendly_name ?? entityId);
  }

  private _icon(value: string, onChange: (v: string) => void) {
    if (customElements.get("ha-icon-picker") && this.hass) {
      return html`<ha-icon-picker
        .hass=${this.hass}
        .value=${value}
        @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
          ev.stopPropagation();
          onChange(ev.detail.value ?? "");
        }}
      ></ha-icon-picker>`;
    }
    return html`<input
      type="text"
      placeholder="mdi:…"
      .value=${value}
      @input=${(ev: Event) => onChange((ev.target as HTMLInputElement).value)}
    />`;
  }

  private _area() {
    const l = this._l;
    const onChange = (id: string) => this._set(applyArea(this._draft, id, this.hass, !this.room));
    if (this._native && this.hass) {
      return html`<ha-selector
        .hass=${this.hass}
        .selector=${{ area: {} }}
        .value=${this._draft.area_id || undefined}
        @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
          ev.stopPropagation();
          onChange(ev.detail.value ?? "");
        }}
      ></ha-selector>`;
    }
    const areas = Object.values(this.hass?.areas ?? {}).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return html`<select
      id="area"
      @change=${(ev: Event) => onChange((ev.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!this._draft.area_id}>${l.t("room_area_none")}</option>
      ${areas.map(
        (a) =>
          html`<option value=${a.area_id} ?selected=${a.area_id === this._draft.area_id}>
            ${a.name}
          </option>`,
      )}
      ${
        this._draft.area_id && !this.hass?.areas?.[this._draft.area_id]
          ? html`<option value=${this._draft.area_id} selected>${this._draft.area_id}</option>`
          : nothing
      }
    </select>`;
  }

  /** One entity (sensors). */
  private _entity(
    value: string,
    selector: Record<string, unknown>,
    listId: string,
    onChange: (v: string) => void,
    candidates: string[],
  ) {
    if (this._native && this.hass) {
      return html`<ha-selector
        .hass=${this.hass}
        .selector=${{ entity: selector }}
        .value=${value || undefined}
        @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
          ev.stopPropagation();
          onChange(ev.detail.value ?? "");
        }}
      ></ha-selector>`;
    }
    return html`<input
        type="text"
        list=${listId}
        placeholder="sensor.…"
        .value=${value}
        @change=${(ev: Event) => onChange((ev.target as HTMLInputElement).value.trim())}
      /><datalist id=${listId}>
        ${candidates.map((id) => html`<option value=${id}></option>`)}
      </datalist>`;
  }

  private _sensorCandidates(deviceClass: string): string[] {
    return Object.values(this.hass?.states ?? {})
      .filter(
        (e) => e.entity_id.startsWith("sensor.") && e.attributes?.device_class === deviceClass,
      )
      .map((e) => e.entity_id)
      .sort();
  }

  private _windowEntities() {
    const l = this._l;
    const d = this._draft;
    const sug = suggestions(this.hass, d.area_id || null).windows.filter(
      (id) => !d.windows.includes(id),
    );
    const add = (id: string) => {
      const v = id.trim();
      if (v && !d.windows.includes(v)) this._set({ windows: [...d.windows, v] });
    };
    const binary = Object.keys(this.hass?.states ?? {})
      .filter((id) => id.startsWith("binary_sensor."))
      .sort();
    return html`
      ${
        this._native && this.hass
          ? html`<ha-selector
              .hass=${this.hass}
              .selector=${{ entity: { domain: "binary_sensor", multiple: true } }}
              .value=${d.windows}
              @value-changed=${(ev: CustomEvent<{ value?: string[] }>) => {
                ev.stopPropagation();
                this._set({ windows: ev.detail.value ?? [] });
              }}
            ></ha-selector>`
          : html`<ul class="contacts">
                ${d.windows.map(
                  (id) =>
                    html`<li>
                      <span class="cname" title=${id}>${this._name(id)}</span>
                      <button
                        class="mini"
                        aria-label=${l.t("room_remove_contact", { entity: id })}
                        @click=${() => this._set({ windows: d.windows.filter((x) => x !== id) })}
                      >
                        ×
                      </button>
                    </li>`,
                )}
              </ul>
              <div class="addrow">
                <input
                  type="text"
                  id="window-add"
                  list="zw-binary-sensors"
                  placeholder="binary_sensor.…"
                  @keydown=${(ev: KeyboardEvent) => {
                    if (ev.key !== "Enter") return;
                    const input = ev.target as HTMLInputElement;
                    add(input.value);
                    input.value = "";
                  }}
                  @change=${(ev: Event) => {
                    const input = ev.target as HTMLInputElement;
                    add(input.value);
                    input.value = "";
                  }}
                /><datalist id="zw-binary-sensors">
                  ${binary.map((id) => html`<option value=${id}></option>`)}
                </datalist>
              </div>`
      }
      ${
        sug.length
          ? html`<div class="sugg">
              <span class="muted">${l.t("room_suggestions")}</span>
              ${sug.map(
                (id) =>
                  html`<button class="chipbtn" data-suggest=${id} @click=${() => add(id)}>
                    + ${this._name(id)}
                  </button>`,
              )}
            </div>`
          : nothing
      }
    `;
  }

  private _delayLabel(n: number): string {
    const l = this._l;
    if (n === 0) return l.t("delay_none");
    if (n >= 60 && n % 60 === 0) return l.t("delay_minutes", { n: n / 60 });
    return l.t("delay_seconds", { n });
  }

  private _delay(value: number, onChange: (n: number) => void, id: string) {
    const options = [...new Set([...DELAY_PRESETS, value])].sort((a, b) => a - b);
    return html`<select
      id=${id}
      @change=${(ev: Event) => onChange(Number((ev.target as HTMLSelectElement).value))}
    >
      ${options.map(
        (n) => html`<option value=${n} ?selected=${n === value}>${this._delayLabel(n)}</option>`,
      )}
    </select>`;
  }

  // --- Plans ---------------------------------------------------------------------------

  private _roomPlans(): Plan[] {
    const room = this.room;
    if (!room) return [];
    return this.plans.filter((p) => p.room === room.id);
  }

  private _plansSection() {
    const l = this._l;
    const room = this.room;
    if (!room) {
      return html`<div class="panel"><span class="muted">${l.t("room_save_first")}</span></div>`;
    }
    const ctx = { hass: this.hass, l };
    const plans = this._roomPlans();
    const free = this.plans.filter((p) => !p.room || p.room_missing);
    const newPath = routePath({ name: "new", room: room.id });
    return html`
      <div class="separator"><span>${l.t("room_plans")}</span><span class="line"></span></div>
      <div class="panel">
        ${
          plans.length
            ? plans.map((p) => {
                const row = overviewRow(ctx, p);
                const reaction = p.room_reactions?.window ?? "";
                const path = routePath({ name: "plan", planId: p.id });
                return html`<div class="planrow" data-plan=${p.id}>
                  <div class="planhead">
                    <a class="planname" href=${path} @click=${this._link(path)}>${p.name}</a>
                    ${
                      row.profile
                        ? html`<span class="pchip" style="color:${row.profile.color}"
                            >${row.profile.name}</span
                          >`
                        : html`<span class="muted">${row.state}</span>`
                    }
                  </div>
                  <label class="field">
                    <span class="label">${l.t("room_window_reaction")}</span>
                    <select
                      class="reaction"
                      ?disabled=${this._busy}
                      @change=${(ev: Event) =>
                        this._savePlan(
                          withWindowReaction(p, (ev.target as HTMLSelectElement).value),
                        )}
                    >
                      <option value="" ?selected=${reaction === ""}>${l.t("room_ignore")}</option>
                      ${p.profiles.map(
                        (pr) =>
                          html`<option value=${pr.id} ?selected=${pr.id === reaction}>
                            ${pr.name}
                          </option>`,
                      )}
                    </select>
                  </label>
                  <button
                    class="linkbtn remove-plan"
                    ?disabled=${this._busy}
                    @click=${() => this._savePlan(withRoom(p, null))}
                  >
                    ${l.t("room_remove_plan")}
                  </button>
                </div>`;
              })
            : html`<span class="muted">${l.t("room_no_plans")}</span>`
        }
        ${
          free.length
            ? html`<div class="assign">
                <select
                  id="assign"
                  @change=${(ev: Event) => (this._assign = (ev.target as HTMLSelectElement).value)}
                >
                  <option value="" ?selected=${!this._assign}>${l.t("room_assign_choose")}</option>
                  ${free.map(
                    (p) =>
                      html`<option value=${p.id} ?selected=${p.id === this._assign}>
                        ${p.name}
                      </option>`,
                  )}
                </select>
                <button
                  class="secondary assign-btn"
                  ?disabled=${!this._assign || this._busy}
                  @click=${() => {
                    const plan = free.find((p) => p.id === this._assign);
                    this._assign = "";
                    if (plan) {
                      this._savePlan(withRoom(plan, room.id, defaultWindowProfile(plan.profiles)));
                    }
                  }}
                >
                  ${l.t("room_assign_plan")}
                </button>
              </div>`
            : nothing
        }
        <a class="linkbtn new-plan" href=${newPath} @click=${this._link(newPath)}
          >+ ${l.t("room_new_plan")}</a
        >
      </div>
    `;
  }

  // --- Render --------------------------------------------------------------------------

  protected render() {
    if (!this.localize) return nothing;
    const l = this._l;
    const d = this._draft;
    return html`
      <div class="panel">
        <label class="field">
          <span class="label">${l.t("room_area")}</span>
          ${this._area()}
        </label>
        <label class="field">
          <span class="label">${l.t("name")}</span>
          <input
            id="room-name"
            type="text"
            .value=${d.name}
            @input=${(ev: Event) =>
              this._set({ name: (ev.target as HTMLInputElement).value, nameTouched: true })}
          />
        </label>
        <label class="field">
          <span class="label">${l.t("icon")}</span>
          ${this._icon(d.icon, (icon) => this._set({ icon }))}
        </label>
      </div>

      <div class="separator"><span>${l.t("room_windows")}</span><span class="line"></span></div>
      <div class="panel">
        <div class="field">
          <span class="label">${l.t("room_window_entities")}</span>
          ${this._windowEntities()}
        </div>
        <div class="row2">
          <label class="field">
            <span class="label">${l.t("room_open_delay")}</span>
            ${this._delay(d.open_delay, (n) => this._set({ open_delay: n }), "open-delay")}
          </label>
          <label class="field">
            <span class="label">${l.t("room_close_delay")}</span>
            ${this._delay(d.close_delay, (n) => this._set({ close_delay: n }), "close-delay")}
          </label>
        </div>
      </div>

      <div class="separator"><span>${l.t("room_sensors")}</span><span class="line"></span></div>
      <div class="panel">
        <div class="field">
          <span class="label">${l.t("room_temperature")}</span>
          ${this._entity(
            d.temperature,
            { domain: "sensor", device_class: "temperature" },
            "zw-temp",
            (temperature) => this._set({ temperature }),
            this._sensorCandidates("temperature"),
          )}
        </div>
        <div class="field">
          <span class="label">${l.t("room_humidity")}</span>
          ${this._entity(
            d.humidity,
            { domain: "sensor", device_class: "humidity" },
            "zw-hum",
            (humidity) => this._set({ humidity }),
            this._sensorCandidates("humidity"),
          )}
        </div>
      </div>

      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      ${
        this._confirmDiscard
          ? html`<div class="confirm-box" role="alert">
              <span>${l.t("discard_changes")}</span>
              <div class="actions">
                <button
                  class="secondary grow"
                  @click=${() => {
                    this._confirmDiscard = false;
                    this._pendingPath = undefined;
                  }}
                >
                  ${l.t("cancel")}
                </button>
                <button
                  class="danger-fill grow"
                  @click=${() => (this._pendingPath ? navigate(this._pendingPath) : this._fire("zw-cancel"))}
                >
                  ${l.t("discard")}
                </button>
              </div>
            </div>`
          : nothing
      }
      <div class="actions">
        <button class="danger cancel" @click=${() => this.requestClose()}>${l.t("cancel")}</button>
        <button class="primary save" ?disabled=${this._busy} @click=${this._save}>
          ${l.t("save")}
        </button>
      </div>

      ${this._plansSection()}
      ${
        this.room
          ? this._confirmDelete
            ? html`<div class="confirm-box" role="alert">
                <span>${l.t("room_delete_confirm", { name: this.room.name })}</span>
                <div class="actions">
                  <button class="secondary grow" @click=${() => (this._confirmDelete = false)}>
                    ${l.t("cancel")}
                  </button>
                  <button class="danger-fill grow" ?disabled=${this._busy} @click=${this._delete}>
                    ${l.t("room_delete")}
                  </button>
                </div>
              </div>`
            : html`<button
                class="text-danger delete-room"
                @click=${() => (this._confirmDelete = true)}
              >
                ${l.t("room_delete")}
              </button>`
          : nothing
      }
    `;
  }

  static styles = [
    tokens,
    displayStyles,
    pageStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      input:focus-visible,
      select:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
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
      select {
        min-height: 42px;
      }
      select option {
        color: initial;
      }
      .contacts {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .contacts li {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 4px 4px 12px;
        border-radius: 18px;
        background: var(--zw-surface-2);
      }
      .cname {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mini {
        width: 44px;
        height: 44px;
        border-radius: 22px;
        font-size: 20px;
      }
      .sugg {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .chipbtn,
      .secondary {
        min-height: 44px;
        padding: 0 16px;
        border-radius: 22px;
        background: var(--zw-surface-2);
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text);
      }
      .planrow {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--zw-border);
      }
      .planhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .planname {
        font-size: 15px;
        font-weight: 600;
        color: var(--zw-text);
        text-decoration: none;
      }
      .pchip {
        font-size: 13px;
        font-weight: 600;
      }
      .assign {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .assign select {
        flex: 1 1 160px;
      }
      .linkbtn {
        align-self: flex-start;
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text);
        text-decoration: underline;
        text-underline-offset: 3px;
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
      .grow {
        flex: 1;
      }
      .actions button,
      .confirm-box button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
      }
      .text-danger {
        align-self: center;
        min-height: 44px;
        color: var(--zw-danger);
        font-size: 14px;
        font-weight: 600;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-room-editor": ZeitwerkRoomEditor;
  }
}
