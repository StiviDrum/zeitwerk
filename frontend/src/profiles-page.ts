/**
 * Profiles page (in-card): name, icon, colour, default profile and what each
 * profile switches. Either one entity for all profiles (each sets its own
 * value) or own "entity -> value" rows per profile; complex profiles can be
 * edited with Home Assistant's action editor. Changes stay local until
 * "Speichern".
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { PALETTE, tint } from "./colors";
import { moveItem } from "./conditions";
import { ensureHaSelector } from "./conditions-editor";
import type { Localizer } from "./localize";
import {
  MAX_PROFILES,
  adaptRow,
  assignIds,
  buildAction,
  defaultRow,
  nextColor,
  parseProfile,
  profileUsage,
  replaceMissingProfiles,
  rowKind,
  sharedEntity,
  type ActionRow,
  type RowKind,
} from "./profile-actions";
import { stepDecimals } from "./quickview";
import type { PlanMutator } from "./rules-page";
import { pageStyles, tokens } from "./styles";
import type { HomeAssistant, Plan, ProfileAction } from "./types";

/** Extra colours beyond the profile palette. */
const COLORS = [...PALETTE, "#5ed1e0", "#ff5f5f", "#b5e061"];

interface DraftProfile {
  /** Stable key while editing (ids of new profiles are made on save). */
  key: number;
  id: string;
  name: string;
  icon: string;
  color: string;
  rows: ActionRow[];
  /** Edited as raw actions (HA action editor). */
  advanced: boolean;
  actions: ProfileAction[];
  actionsValid: boolean;
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

export class ZeitwerkProfiles extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public save!: (mutate: PlanMutator) => Promise<void>;

  @state() private _profiles: DraftProfile[] = [];
  @state() private _defaultKey = 0;
  @state() private _shared = true;
  @state() private _entity = "";
  @state() private _open?: number;
  @state() private _dirty = false;
  @state() private _confirmDiscard = false;
  @state() private _confirmDelete?: number;
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _native = false;
  @state() private _drag?: { key: number; startY: number; dy: number; centers: number[] };
  private _nextKey = 1;
  private _loaded = false;

  public connectedCallback(): void {
    super.connectedCallback();
    ensureHaSelector().then((ok) => (this._native = ok));
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("plan") && this.plan && !this._loaded) {
      this._loaded = true;
      this._load();
    }
  }

  private _load(): void {
    const plan = this.plan;
    this._profiles = plan.profiles.map((p) => {
      const rows = parseProfile(p);
      return {
        key: this._nextKey++,
        id: p.id,
        name: p.name,
        icon: p.icon ?? "",
        color: p.color ?? "",
        rows: rows ?? [],
        advanced: rows === null,
        actions: structuredClone(p.actions),
        actionsValid: true,
      };
    });
    const def = this._profiles.find((p) => p.id === plan.default_profile);
    this._defaultKey = def?.key ?? this._profiles[0]?.key ?? 0;
    const shared = sharedEntity(plan.profiles);
    const empty = plan.profiles.every((p) => !p.actions.length);
    this._shared = shared !== null || empty;
    this._entity = shared ?? "";
    this._open = undefined;
    this._dirty = false;
  }

  private get _t() {
    return this.localize.t.bind(this.localize);
  }

  private _kind(entityId: string): RowKind {
    return rowKind(
      entityId,
      this.hass?.states[entityId],
      this.hass?.config?.unit_system?.temperature ?? "°C",
    );
  }

  private _fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private _change(key: number, changes: Partial<DraftProfile>): void {
    this._profiles = this._profiles.map((p) => (p.key === key ? { ...p, ...changes } : p));
    this._dirty = true;
    this._error = undefined;
  }

  // --- Mode and entity ------------------------------------------------------------

  private _setShared(shared: boolean): void {
    if (shared === this._shared) return;
    this._dirty = true;
    this._error = undefined;
    this._shared = shared;
    if (!shared) return;
    const def = this._profiles.find((p) => p.key === this._defaultKey);
    const entity =
      def?.rows[0]?.entityId ?? this._profiles.find((p) => p.rows.length)?.rows[0]?.entityId ?? "";
    this._setEntity(entity);
  }

  private _setEntity(entityId: string): void {
    this._entity = entityId;
    this._dirty = true;
    this._error = undefined;
    if (!entityId) return;
    const kind = this._kind(entityId);
    this._profiles = this._profiles.map((p, i) => {
      const row = p.rows[0];
      return {
        ...p,
        advanced: false,
        actionsValid: true,
        rows: [row ? adaptRow(row, entityId, kind, i) : defaultRow(entityId, kind, i)],
      };
    });
  }

  // --- Profiles -------------------------------------------------------------------

  private _add(): void {
    if (this._profiles.length >= MAX_PROFILES) return;
    const t = this._t;
    const def = this._profiles.find((p) => p.key === this._defaultKey);
    const index = this._profiles.length;
    let rows: ActionRow[] = def ? structuredClone(def.rows) : [];
    if (this._shared && this._entity) {
      rows = [defaultRow(this._entity, this._kind(this._entity), index)];
    }
    const key = this._nextKey++;
    this._profiles = [
      ...this._profiles,
      {
        key,
        id: "",
        name: t("new_profile_name", { n: index + 1 }),
        icon: "",
        color: nextColor(this._profiles.map((p) => ({ color: p.color }))),
        rows,
        advanced: !!def?.advanced && !this._shared,
        actions: def ? structuredClone(def.actions) : [],
        actionsValid: true,
      },
    ];
    this._open = key;
    this._dirty = true;
  }

  private _delete(key: number): void {
    this._profiles = this._profiles.filter((p) => p.key !== key);
    this._confirmDelete = undefined;
    this._open = undefined;
    this._dirty = true;
  }

  private _setRow(profile: DraftProfile, index: number, row: ActionRow): void {
    this._change(profile.key, { rows: profile.rows.map((r, i) => (i === index ? row : r)) });
  }

  private _setAdvanced(profile: DraftProfile, advanced: boolean): void {
    if (advanced) {
      this._change(profile.key, {
        advanced: true,
        actions: profile.rows.map((r) => buildAction(r, this._kind(r.entityId))),
        actionsValid: true,
      });
      return;
    }
    const rows = parseProfile({ actions: profile.actions });
    if (rows) this._change(profile.key, { advanced: false, rows });
  }

  // --- Sort (drag the handle or use the arrow keys) -------------------------------

  private _onHandleDown(key: number, ev: PointerEvent): void {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this._open = undefined;
    this._confirmDelete = undefined;
    const centers = [...this.renderRoot.querySelectorAll<HTMLElement>(".prof")].map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    this._drag = { key, startY: ev.clientY, dy: 0, centers };
    ev.preventDefault();
  }

  private _onHandleMove = (ev: PointerEvent): void => {
    if (this._drag) this._drag = { ...this._drag, dy: ev.clientY - this._drag.startY };
  };

  private _onHandleUp = (): void => {
    const drag = this._drag;
    this._drag = undefined;
    if (!drag) return;
    const from = this._profiles.findIndex((p) => p.key === drag.key);
    const center = drag.centers[from] + drag.dy;
    const to = drag.centers.filter((c, i) => i !== from && c < center).length;
    this._move(from, to);
  };

  private _onHandleKey(key: number, ev: KeyboardEvent): void {
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    const from = this._profiles.findIndex((p) => p.key === key);
    this._move(from, from + (ev.key === "ArrowUp" ? -1 : 1));
  }

  private _move(from: number, to: number): void {
    const target = Math.max(0, Math.min(this._profiles.length - 1, to));
    if (from < 0 || target === from) return;
    this._profiles = moveItem(this._profiles, from, target);
    this._dirty = true;
  }

  // --- Save -----------------------------------------------------------------------

  private _validate(): string | undefined {
    const t = this._t;
    if (this._profiles.some((p) => !p.name.trim())) return t("name_missing");
    if (this._shared && !this._entity) return t("entity_missing");
    if (!this._shared && this._profiles.some((p) => !p.advanced && p.rows.some((r) => !r.entityId)))
      return t("entity_missing");
    const bad = this._profiles.find((p) => p.advanced && !p.actionsValid);
    if (bad) return t("invalid_actions", { name: bad.name });
    return undefined;
  }

  private async _save(): Promise<void> {
    const error = this._validate();
    if (error) {
      this._error = error;
      return;
    }
    const drafts = assignIds(this._profiles.map((p) => ({ ...p, name: p.name.trim() })));
    const profiles = drafts.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color || null,
      icon: p.icon || null,
      actions: p.advanced ? p.actions : p.rows.map((r) => buildAction(r, this._kind(r.entityId))),
    }));
    const defaultId = drafts.find((p) => p.key === this._defaultKey)?.id ?? profiles[0].id;
    this._busy = true;
    this._error = undefined;
    try {
      await this.save((plan) => {
        plan.profiles = profiles;
        plan.default_profile = defaultId;
        replaceMissingProfiles(plan);
      });
      this._dirty = false;
      this._fire("zw-back");
    } catch (err) {
      this._error = this._t("save_failed", { error: errorText(err) });
    } finally {
      this._busy = false;
    }
  }

  private _back = (): void => {
    if (this._dirty) {
      this._confirmDiscard = true;
      return;
    }
    this._fire("zw-back");
  };

  // --- Rendering ------------------------------------------------------------------

  private _entityPicker(value: string, onChange: (id: string) => void) {
    if (this._native && this.hass) {
      return html`<ha-selector
        .hass=${this.hass}
        .selector=${{ entity: {} }}
        .value=${value}
        @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
          ev.stopPropagation();
          onChange(ev.detail.value ?? "");
        }}
      ></ha-selector>`;
    }
    return html`<input
        type="text"
        list="zw-profile-entities"
        placeholder="light.…"
        aria-label=${this._t("entity")}
        .value=${value}
        @change=${(ev: Event) => onChange((ev.target as HTMLInputElement).value.trim())}
      /><datalist id="zw-profile-entities">
        ${Object.keys(this.hass?.states ?? {})
          .sort()
          .map((id) => html`<option value=${id}></option>`)}
      </datalist>`;
  }

  private _switch(on: boolean, label: string, onChange: (on: boolean) => void) {
    return html`<button
      class="switch"
      role="switch"
      aria-label=${label}
      aria-checked=${on ? "true" : "false"}
      @click=${() => onChange(!on)}
    >
      <span></span>
    </button>`;
  }

  /** Value control for one row (number, option, on/off, light). */
  private _valueControl(profile: DraftProfile, index: number) {
    const t = this._t;
    const row = profile.rows[index];
    const kind = this._kind(row.entityId);
    const label = `${profile.name} ${t("value")}`;
    const set = (changes: Partial<ActionRow>) =>
      this._setRow(profile, index, { ...row, ...changes });
    switch (kind.kind) {
      case "light":
        return html`<span class="value">
          ${
            row.on
              ? html`<input
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    placeholder="–"
                    title=${t("brightness_hint")}
                    aria-label=${`${profile.name} ${t("brightness")}`}
                    .value=${row.value === null ? "" : String(row.value)}
                    @change=${(ev: Event) => {
                      const v = (ev.target as HTMLInputElement).value;
                      set({ value: v === "" ? null : Math.min(100, Math.max(1, Number(v))) });
                    }}
                  /><span class="unit">%</span>`
              : nothing
          }
          ${this._switch(row.on, label, (on) => set({ on }))}
        </span>`;
      case "toggle":
        return this._switch(row.on, label, (on) => set({ on }));
      case "select":
        return html`<select
          aria-label=${label}
          @change=${(ev: Event) => set({ value: (ev.target as HTMLSelectElement).value })}
        >
          ${(kind.options.includes(String(row.value))
            ? kind.options
            : [String(row.value), ...kind.options]
          ).map((o) => html`<option value=${o} ?selected=${o === row.value}>${o}</option>`)}
        </select>`;
      default:
        return html`<span class="value">
          <input
            type="number"
            aria-label=${label}
            min=${kind.min}
            max=${kind.max}
            step=${kind.step}
            .value=${row.value === null ? "" : String(row.value)}
            @change=${(ev: Event) => {
              const n = Number((ev.target as HTMLInputElement).value);
              set({ value: Number(n.toFixed(stepDecimals(kind.step))) });
            }}
          />${kind.unit ? html`<span class="unit">${kind.unit}</span>` : nothing}
        </span>`;
    }
  }

  private _friendly(entityId: string): string {
    const name = this.hass?.states[entityId]?.attributes.friendly_name;
    return typeof name === "string" ? name : entityId;
  }

  private _rowText(row: ActionRow): string {
    const t = this._t;
    const kind = this._kind(row.entityId);
    switch (kind.kind) {
      case "light":
        return row.on ? `${t("on")}${row.value !== null ? ` ${row.value} %` : ""}` : t("off");
      case "toggle":
        return row.on ? t("on") : t("off");
      case "select":
        return String(row.value);
      default: {
        const n = Number(row.value);
        const text = Number.isFinite(n)
          ? new Intl.NumberFormat(this.localize.lang, {
              maximumFractionDigits: stepDecimals(kind.step),
            }).format(n)
          : String(row.value);
        return kind.unit ? `${text} ${kind.unit}` : text;
      }
    }
  }

  private _summary(p: DraftProfile): string {
    const t = this._t;
    if (p.advanced) return t("own_actions", { n: p.actions.length });
    if (!p.rows.length) return t("no_actions");
    if (this._shared) return p.rows[0].entityId ? this._rowText(p.rows[0]) : "";
    return p.rows
      .map((r) => (r.entityId ? `${this._friendly(r.entityId)} ${this._rowText(r)}` : "…"))
      .join(" · ");
  }

  private _renderBody(p: DraftProfile) {
    const t = this._t;
    const isDefault = p.key === this._defaultKey;
    const usage = p.id ? profileUsage(this.plan, p.id) : { blocks: 0, rules: 0 };
    const defName = this._profiles.find((x) => x.key === this._defaultKey)?.name ?? "";
    return html`<div class="body">
      <label class="field">
        <span class="label">${t("name")}</span>
        <input
          type="text"
          .value=${p.name}
          @input=${(ev: Event) => this._change(p.key, { name: (ev.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span class="label">${t("icon")}</span>
        ${
          customElements.get("ha-icon-picker") && this.hass
            ? html`<ha-icon-picker
                .hass=${this.hass}
                .value=${p.icon}
                @value-changed=${(ev: CustomEvent<{ value: string }>) => {
                  ev.stopPropagation();
                  this._change(p.key, { icon: ev.detail.value ?? "" });
                }}
              ></ha-icon-picker>`
            : html`<input
                type="text"
                placeholder="mdi:…"
                .value=${p.icon}
                @input=${(ev: Event) => this._change(p.key, { icon: (ev.target as HTMLInputElement).value.trim() })}
              />`
        }
      </label>
      <div class="field">
        <span class="label">${t("color")}</span>
        <div class="swatches" role="radiogroup" aria-label=${t("color")}>
          ${COLORS.map(
            (c) =>
              html`<button
                class="swatch"
                role="radio"
                aria-label=${c}
                aria-checked=${p.color.toLowerCase() === c.toLowerCase() ? "true" : "false"}
                style="background:${c}"
                @click=${() => this._change(p.key, { color: c })}
              ></button>`,
          )}
        </div>
      </div>
      ${this._renderActions(p)}
      <div class="between">
        <span class="ltext"
          ><span class="label2">${t("default_profile_switch")}</span
          ><span class="muted">${t("default_profile_hint")}</span></span
        >
        ${this._switch(isDefault, t("default_profile_switch"), (on) => {
          if (on) {
            this._defaultKey = p.key;
            this._dirty = true;
          }
        })}
      </div>
      ${
        this._confirmDelete === p.key
          ? html`<div class="confirm" role="alert">
              <span class="label2">${t("delete_profile_confirm", { name: p.name })}</span>
              ${
                usage.blocks || usage.rules
                  ? html`<span class="muted"
                      >${t("delete_profile_used", { ...usage, profile: defName })}</span
                    >`
                  : nothing
              }
              <div class="actions">
                <button class="secondary" @click=${() => (this._confirmDelete = undefined)}>
                  ${t("cancel")}
                </button>
                <button class="danger-fill" @click=${() => this._delete(p.key)}>
                  ${t("delete")}
                </button>
              </div>
            </div>`
          : html`<button
              class="text-danger"
              ?disabled=${isDefault || this._profiles.length <= 1}
              @click=${() => (this._confirmDelete = p.key)}
            >
              ${t("delete_profile")}
            </button>`
      }
    </div>`;
  }

  private _renderActions(p: DraftProfile) {
    const t = this._t;
    if (this._shared) {
      if (!this._entity || !p.rows[0]) return nothing;
      return html`<div class="between">
        <span class="label2">${t("value")}</span>
        ${this._valueControl(p, 0)}
      </div>`;
    }
    if (p.advanced) {
      return html`<div class="field">
        <span class="label">${t("own_actions", { n: p.actions.length })}</span>
        <zeitwerk-conditions-editor
          .hass=${this.hass}
          .localize=${this.localize}
          .kind=${"action"}
          .value=${p.actions}
          @value-changed=${(ev: CustomEvent<{ value: ProfileAction[] }>) => {
            ev.stopPropagation();
            this._change(p.key, { actions: ev.detail.value, actionsValid: true });
          }}
          @value-invalid=${() => this._change(p.key, { actionsValid: false })}
        ></zeitwerk-conditions-editor>
        ${
          parseProfile({ actions: p.actions })
            ? html`<button class="link" @click=${() => this._setAdvanced(p, false)}>
                ${t("simple_actions")}
              </button>`
            : nothing
        }
      </div>`;
    }
    return html`<div class="field">
      <span class="label">${t("profile_switches")}</span>
      ${p.rows.map(
        (row, i) =>
          html`<div class="arow">
            <div class="apick">
              ${this._entityPicker(row.entityId, (id) =>
                this._setRow(
                  p,
                  i,
                  id ? adaptRow(row, id, this._kind(id), 0) : { ...row, entityId: "" },
                ),
              )}
            </div>
            <div class="aval">
              ${row.entityId ? this._valueControl(p, i) : nothing}
              <button
                class="mini"
                aria-label=${t("remove_entity")}
                @click=${() => this._change(p.key, { rows: p.rows.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          </div>`,
      )}
      <div class="arow-actions">
        <button
          class="add small"
          @click=${() => this._change(p.key, { rows: [...p.rows, { entityId: "", on: true, value: null }] })}
        >
          ${t("add_entity")}
        </button>
        <button class="link" @click=${() => this._setAdvanced(p, true)}>
          ${t("advanced_actions")}
        </button>
      </div>
    </div>`;
  }

  protected render() {
    if (!this.plan || !this.localize) return nothing;
    const t = this._t;
    const lossy = !this._shared && this._profiles.some((p) => p.advanced || p.rows.length > 1);
    const def = this._profiles.find((p) => p.key === this._defaultKey);
    const defaultChanged = def && def.id !== this.plan.default_profile;
    return html`
      <div class="head">
        <button class="round" aria-label=${t("back")} @click=${this._back}>
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
        <div class="titles">
          <span class="title">${t("profiles_title")}</span>
          <span class="sub">${this.plan.name}</span>
        </div>
      </div>

      <div class="panel">
        <span class="label">${t("controls")}</span>
        <div class="segmented" role="radiogroup" aria-label=${t("controls")}>
          ${([true, false] as const).map(
            (shared) =>
              html`<button
                role="radio"
                aria-checked=${this._shared === shared ? "true" : "false"}
                @click=${() => this._setShared(shared)}
              >
                ${t(shared ? "mode_shared" : "mode_each")}
              </button>`,
          )}
        </div>
        ${
          this._shared
            ? html`${this._entityPicker(this._entity, (id) => this._setEntity(id))}
                <span class="muted">${t("mode_shared_hint")}</span>`
            : html`<span class="muted">${t("mode_each_hint")}</span>
                ${lossy ? html`<span class="muted small">${t("mode_shared_lossy")}</span>` : nothing}`
        }
      </div>

      <div class="separator">
        <span>${t("section_profiles")}</span>
        <span class="shint"
          >${t("profiles_count", { n: this._profiles.length, max: MAX_PROFILES })}</span
        >
        <span class="line"></span>
      </div>
      <div class="list">
        ${this._profiles.map((p) => {
          const open = this._open === p.key;
          const color = p.color || "#aeaeb8";
          const drag = this._drag?.key === p.key ? this._drag : undefined;
          return html`<div
            class="prof ${open ? "open" : ""} ${drag ? "dragging" : ""}"
            style=${drag ? `transform:translateY(${drag.dy}px)` : ""}
          >
            <div class="prow">
              <button
                class="handle"
                aria-label=${t("drag_handle", { name: p.name })}
                title=${`${t("move_up", { name: p.name })} / ${t("move_down", { name: p.name })}`}
                @pointerdown=${(ev: PointerEvent) => this._onHandleDown(p.key, ev)}
                @pointermove=${this._onHandleMove}
                @pointerup=${this._onHandleUp}
                @pointercancel=${() => (this._drag = undefined)}
                @keydown=${(ev: KeyboardEvent) => this._onHandleKey(p.key, ev)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </button>
              <button
                class="phead"
                aria-expanded=${open ? "true" : "false"}
                @click=${() => {
                  this._open = open ? undefined : p.key;
                  this._confirmDelete = undefined;
                }}
              >
                <span class="picon" style="background:${tint(color, 22)};color:${color}">
                  <ha-icon .icon=${p.icon || "mdi:circle-medium"}></ha-icon>
                </span>
                <span class="ptext">
                  <span class="pname">${p.name || "…"}</span>
                  <span class="psub">${this._summary(p)}</span>
                </span>
                ${p.key === this._defaultKey ? html`<span class="badge">${t("default_suffix")}</span>` : nothing}
                <svg
                  class="chev"
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
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
            ${open ? this._renderBody(p) : nothing}
          </div>`;
        })}
        <button class="add" ?disabled=${this._profiles.length >= MAX_PROFILES} @click=${this._add}>
          ${t("add_profile")}
        </button>
      </div>
      ${defaultChanged ? html`<div class="note">${t("default_changed", { name: def!.name })}</div>` : nothing}
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      ${
        this._confirmDiscard
          ? html`<div class="confirm" role="alert">
              <span class="label2">${t("discard_changes")}</span>
              <div class="actions">
                <button class="secondary" @click=${() => (this._confirmDiscard = false)}>
                  ${t("cancel")}
                </button>
                <button class="danger-fill" @click=${() => this._fire("zw-back")}>
                  ${t("discard")}
                </button>
              </div>
            </div>`
          : html`<div class="actions">
              <button class="danger" @click=${this._back}>${t("cancel")}</button>
              <button class="primary" ?disabled=${this._busy || !this._dirty} @click=${this._save}>
                ${t("save")}
              </button>
            </div>`
      }
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
      .round {
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        border-radius: 22px;
        background: var(--zw-surface-2);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .titles {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .title {
        font-size: 20px;
        font-weight: 700;
      }
      .sub,
      .shint,
      .muted,
      .psub {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .small {
        font-size: 11px;
      }
      .panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
        border-radius: 26px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
      }
      .label {
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
      }
      .label2 {
        font-size: 14px;
        font-weight: 500;
      }
      .segmented button {
        flex: 1;
        min-height: 36px;
        padding: 4px 8px;
        border-radius: 15px;
        font-size: 12px;
        font-weight: 600;
      }
      .segmented button[aria-checked="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
      }
      .prof {
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        overflow: hidden;
      }
      .prow {
        display: flex;
        align-items: stretch;
      }
      .handle {
        width: 32px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--zw-text-2);
        touch-action: none;
        cursor: grab;
      }
      .prof.dragging {
        position: relative;
        z-index: 1;
        /* opaque while lifted, so the rows below do not shine through */
        background: linear-gradient(var(--zw-surface-2), var(--zw-surface-2)), var(--zw-bg);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
      }
      .phead {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 60px;
        padding: 8px 14px 8px 0;
        text-align: left;
      }
      .picon {
        width: 38px;
        height: 38px;
        flex-shrink: 0;
        border-radius: 19px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ptext {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .pname {
        font-size: 14px;
        font-weight: 600;
      }
      .psub {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chev {
        display: block;
        color: var(--zw-text-2);
        flex-shrink: 0;
        transform-origin: 50% 50%;
        transform-box: fill-box;
        transition: transform 0.15s;
      }
      .prof.open .chev {
        transform: rotate(180deg);
      }
      .badge {
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 10px;
        background: var(--zw-surface-2);
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .body {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 4px 14px 14px;
        border-top: 1px solid var(--zw-border);
        padding-top: 14px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      .ltext {
        display: flex;
        flex-direction: column;
        gap: 2px;
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
        height: 44px;
      }
      select option {
        color: initial;
      }
      .value {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .value input {
        width: 84px;
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .swatch {
        width: 32px;
        height: 32px;
        border-radius: 16px;
        box-sizing: border-box;
      }
      .swatch[aria-checked="true"] {
        outline: 3px solid var(--zw-text);
        outline-offset: 2px;
      }
      .arow {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: 16px;
        background: var(--zw-surface);
      }
      .apick {
        flex: 1 1 180px;
        min-width: 0;
      }
      .apick input {
        width: 100%;
      }
      .aval {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .arow-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .add {
        height: 48px;
        border-radius: 22px;
        border: 1px dashed color-mix(in srgb, var(--zw-text) 22%, transparent);
        font-size: 14px;
        font-weight: 500;
      }
      .add.small {
        height: 36px;
        padding: 0 14px;
        border-radius: 18px;
        font-size: 13px;
      }
      .link {
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
        text-decoration: underline;
        min-height: 32px;
      }
      .text-danger {
        align-self: flex-start;
        min-height: 36px;
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-danger);
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
        display: block;
      }
      .note {
        font-size: 13px;
        padding: 10px 12px;
        border-radius: 12px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
      }
      .confirm {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border-radius: 16px;
        background: color-mix(in srgb, var(--zw-danger) 10%, transparent);
      }
      .actions button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
      }
      .confirm .actions button {
        height: 44px;
        flex: 1;
      }
      .secondary {
        background: var(--zw-surface-2) !important;
        font-weight: 600;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-profiles": ZeitwerkProfiles;
  }
}
