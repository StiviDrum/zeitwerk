/**
 * Rules page of a plan (docs/mockup/Regeln.dc.html): overrides with priority
 * (drag to sort), activation conditions, and the editors for both.
 *
 * Editors are in-card sub-pages, not modal dialogs: HA's condition editor
 * opens its own dialogs at the document root, which a modal <dialog> would
 * make inert.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { profileColor, tint } from "./colors";
import {
  conditionSummary,
  conditionsSummary,
  moveItem,
  uniqueId,
  type Condition,
} from "./conditions";
import "./conditions-editor";
import type { Localizer } from "./localize";
import { tokens } from "./styles";
import type { HomeAssistant, Override, Plan } from "./types";

export type PlanMutator = (plan: Plan) => void;

type SubPage =
  | { kind: "list" }
  | { kind: "override"; index: number; draft: Override }
  | { kind: "activation"; match: "all" | "any"; conditions: Condition[] };

const ROW_PITCH = 72; // 64 px row + 8 px gap

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

@customElement("zeitwerk-rules")
export class ZeitwerkRules extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public save!: (mutate: PlanMutator) => Promise<void>;

  @state() private _page: SubPage = { kind: "list" };
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _confirmDelete = false;
  @state() private _drag?: { index: number; startY: number; dy: number };
  @state() private _conditionsValid = true;

  private get _admin(): boolean {
    return !!this.hass?.user?.is_admin;
  }

  private _fire(type: string): void {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }

  private async _run(mutate: PlanMutator, done?: () => void): Promise<void> {
    if (!this._admin) {
      this._error = this.localize.t("admin_only");
      return;
    }
    this._busy = true;
    this._error = undefined;
    try {
      await this.save(mutate);
      done?.();
    } catch (err) {
      this._error = this.localize.t("save_failed", { error: errorText(err) });
    } finally {
      this._busy = false;
    }
  }

  private _open(page: SubPage): void {
    this._error = undefined;
    this._confirmDelete = false;
    this._conditionsValid = true;
    this._page = page;
    this.scrollIntoView?.({ block: "nearest" });
  }

  // --- Drag to sort -----------------------------------------------------------

  private _onHandleDown(index: number, ev: PointerEvent): void {
    if (!this._admin) {
      this._error = this.localize.t("admin_only");
      return;
    }
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this._drag = { index, startY: ev.clientY, dy: 0 };
    ev.preventDefault();
  }

  private _onHandleMove(ev: PointerEvent): void {
    if (!this._drag) return;
    this._drag = { ...this._drag, dy: ev.clientY - this._drag.startY };
  }

  private _onHandleUp(): void {
    const drag = this._drag;
    this._drag = undefined;
    if (!drag) return;
    const to = drag.index + Math.round(drag.dy / ROW_PITCH);
    this._move(drag.index, to);
  }

  private _move(from: number, to: number): void {
    const count = this.plan.overrides.length;
    const target = Math.max(0, Math.min(count - 1, to));
    if (target === from) return;
    this._run((plan) => {
      plan.overrides = moveItem(plan.overrides, from, target);
    });
  }

  private _onHandleKey(index: number, ev: KeyboardEvent): void {
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      this._move(index, index + (ev.key === "ArrowUp" ? -1 : 1));
    }
  }

  // --- Rendering ----------------------------------------------------------------

  protected render() {
    if (!this.plan || !this.localize) return nothing;
    switch (this._page.kind) {
      case "override":
        return this._renderOverrideEditor(this._page);
      case "activation":
        return this._renderActivationEditor(this._page);
      default:
        return this._renderList();
    }
  }

  private _head(title: string, sub: string, back: () => void) {
    return html`<div class="head">
      <button class="round" aria-label=${this.localize.t("back")} @click=${back}>
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
        <span class="title">${title}</span>
        <span class="sub">${sub}</span>
      </div>
    </div>`;
  }

  private _separator(title: string, hint?: string) {
    return html`<div class="separator">
      <span>${title}</span>${hint ? html`<span class="shint">${hint}</span>` : nothing}<span
        class="line"
      ></span>
    </div>`;
  }

  private _segmented(
    value: "all" | "any",
    onChange: (v: "all" | "any") => void,
    label: string,
    long = false,
  ) {
    const t = this.localize.t.bind(this.localize);
    return html`<div class="segmented ${long ? "wide" : ""}" role="radiogroup" aria-label=${label}>
      ${(["all", "any"] as const).map(
        (v) =>
          html`<button
            role="radio"
            aria-checked=${v === value ? "true" : "false"}
            ?disabled=${this._busy}
            @click=${() => v !== value && onChange(v)}
          >
            ${long ? t(v === "all" ? "match_all_long" : "match_any_long") : t(v === "all" ? "match_all" : "match_any")}
          </button>`,
      )}
    </div>`;
  }

  private _renderList() {
    const t = this.localize.t.bind(this.localize);
    const plan = this.plan;
    const results = plan.status?.override_results ?? {};
    const activation = plan.activation;
    const actResults = plan.status?.activation_results ?? [];
    return html`
      ${this._head(t("section_rules"), plan.name, () => this._fire("zw-back"))}
      ${this._separator(t("rules_overrides"), t("rules_overrides_hint"))}
      <div class="list">
        ${plan.overrides.map((ov, index) => {
          const profile = plan.profiles.find((p) => p.id === ov.profile);
          const color = profileColor(plan, ov.profile);
          const active = !!results[ov.id];
          const drag = this._drag?.index === index ? this._drag : undefined;
          return html`<div
            class="rule ${drag ? "dragging" : ""}"
            style=${drag ? `transform:translateY(${drag.dy}px)` : ""}
          >
            <button
              class="handle"
              aria-label=${t("drag_handle", { name: ov.name })}
              title=${`${t("move_up", { name: ov.name })} / ${t("move_down", { name: ov.name })}`}
              @pointerdown=${(ev: PointerEvent) => this._onHandleDown(index, ev)}
              @pointermove=${this._onHandleMove}
              @pointerup=${this._onHandleUp}
              @pointercancel=${() => (this._drag = undefined)}
              @keydown=${(ev: KeyboardEvent) => this._onHandleKey(index, ev)}
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
              class="rule-main"
              @click=${() => this._open({ kind: "override", index, draft: structuredClone(ov) })}
            >
              <span class="ricon" style="background:${tint(color, 18)};color:${color}">
                <ha-icon .icon=${profile?.icon || "mdi:swap-vertical"}></ha-icon>
              </span>
              <span class="rtext">
                <span class="rtitle">${ov.name} → ${profile?.name ?? ov.profile}</span>
                <span class="rsub"
                  >${conditionsSummary(ov.conditions, ov.match, this.hass, this.localize)}</span
                >
              </span>
              <span
                class="badge ${active ? "on" : ""}"
                style=${active ? `background:${tint(color, 22)};color:${color}` : ""}
                >${active ? t("badge_active") : t("badge_inactive")}</span
              >
            </button>
          </div>`;
        })}
        <button
          class="add"
          @click=${() =>
            this._open({
              kind: "override",
              index: -1,
              draft: {
                id: "",
                name: "",
                profile:
                  plan.profiles.find((p) => p.id !== plan.default_profile)?.id ??
                  plan.default_profile,
                match: "all",
                conditions: [],
              },
            })}
        >
          ${t("add_override")}
        </button>
      </div>

      ${this._separator(t("rules_activation"))}
      <div class="panel">
        <div class="between">
          <span class="label">${t("plan_runs_when")}</span>
          ${this._segmented(
            activation.match,
            (v) =>
              this._run((p) => {
                p.activation.match = v;
              }),
            t("combine"),
          )}
        </div>
        ${
          activation.conditions.length
            ? activation.conditions.map((c, i) => {
                const ok = actResults[i];
                return html`<div class="cond">
                  <span class="check ${ok ? "ok" : "bad"}" aria-hidden="true"
                    >${ok ? "✓" : "✕"}</span
                  >
                  <span class="ctext">${conditionSummary(c, this.hass, this.localize)}</span>
                  <span class="cstate ${ok ? "ok" : "bad"}"
                    >${ok ? t("fulfilled") : t("not_fulfilled")}</span
                  >
                </div>`;
              })
            : html`<div class="muted">${t("always_runs")}</div>`
        }
        <button
          class="secondary"
          @click=${() =>
            this._open({
              kind: "activation",
              match: activation.match,
              conditions: structuredClone(activation.conditions),
            })}
        >
          ${t("edit_conditions")}
        </button>
        <label class="between">
          <span class="label">${t("otherwise")}</span>
          <select
            ?disabled=${this._busy}
            @change=${(ev: Event) => {
              const value = (ev.target as HTMLSelectElement).value;
              this._run((p) => {
                p.activation.when_inactive = value;
              });
            }}
          >
            <option value="none" ?selected=${activation.when_inactive === "none"}>
              ${t("when_inactive_none")}
            </option>
            ${plan.profiles.map(
              (p) =>
                html`<option
                  value=${`profile:${p.id}`}
                  ?selected=${activation.when_inactive === `profile:${p.id}`}
                >
                  ${t("when_inactive_profile", { profile: p.name })}
                </option>`,
            )}
          </select>
        </label>
        <label class="between">
          <span class="ltext">
            <span class="label">${t("reevaluate")}</span>
            <span class="muted small">${t("reevaluate_hint")}</span>
          </span>
          <button
            class="switch"
            role="switch"
            aria-label=${t("reevaluate")}
            aria-checked=${activation.reevaluate ? "true" : "false"}
            ?disabled=${this._busy}
            @click=${() =>
              this._run((p) => {
                p.activation.reevaluate = !activation.reevaluate;
              })}
          >
            <span></span>
          </button>
        </label>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
    `;
  }

  private _renderOverrideEditor(page: Extract<SubPage, { kind: "override" }>) {
    const t = this.localize.t.bind(this.localize);
    const plan = this.plan;
    const draft = page.draft;
    const isNew = page.index < 0;
    const update = (changes: Partial<Override>) =>
      (this._page = { ...page, draft: { ...draft, ...changes } });
    const back = () => this._open({ kind: "list" });
    const save = () => {
      const name = draft.name.trim();
      if (!name) {
        this._error = t("name_required");
        return;
      }
      this._run((p) => {
        const ov: Override = {
          ...draft,
          name,
          id: isNew
            ? uniqueId(
                name,
                p.overrides.map((o) => o.id),
              )
            : draft.id,
        };
        if (isNew) p.overrides.push(ov);
        else p.overrides[page.index] = ov;
      }, back);
    };
    const remove = () => {
      if (!this._confirmDelete) {
        this._confirmDelete = true;
        return;
      }
      this._run((p) => {
        p.overrides.splice(page.index, 1);
      }, back);
    };
    return html`
      ${this._head(isNew ? t("override_new") : t("override_edit"), plan.name, back)}
      <div class="panel">
        <label class="field">
          <span class="label">${t("name")}</span>
          <input
            type="text"
            .value=${draft.name}
            @input=${(ev: Event) => update({ name: (ev.target as HTMLInputElement).value })}
          />
        </label>
        <div class="field">
          <span class="label">${t("profile")}</span>
          <div class="profiles">
            ${plan.profiles.map((p) => {
              const color = profileColor(plan, p);
              const on = p.id === draft.profile;
              return html`<button
                class="profile"
                aria-pressed=${on ? "true" : "false"}
                style="border-color:${on ? color : "var(--zw-surface-2)"};background:${on ? tint(color, 14) : "var(--zw-surface)"}"
                @click=${() => update({ profile: p.id })}
              >
                <span class="dot" style="background:${color}"></span>${p.name}
              </button>`;
            })}
          </div>
        </div>
        <div class="field">
          <span class="label">${t("combine")}</span>
          ${this._segmented(draft.match, (v) => update({ match: v }), t("combine"), true)}
        </div>
        <div class="field">
          <span class="label">${t("conditions")}</span>
          <zeitwerk-conditions-editor
            .hass=${this.hass}
            .localize=${this.localize}
            .value=${draft.conditions}
            @value-changed=${(ev: CustomEvent<{ value: Condition[] }>) => {
              this._conditionsValid = true;
              update({ conditions: ev.detail.value });
            }}
            @value-invalid=${() => (this._conditionsValid = false)}
          ></zeitwerk-conditions-editor>
        </div>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      <div class="actions">
        ${
          isNew
            ? html`<button class="danger" @click=${back}>${t("cancel")}</button>`
            : html`<button class="danger" ?disabled=${this._busy} @click=${remove}>
                ${this._confirmDelete ? t("confirm_delete") : t("delete")}
              </button>`
        }
        <button class="primary" ?disabled=${this._busy || !this._conditionsValid} @click=${save}>
          ${t("save")}
        </button>
      </div>
    `;
  }

  private _renderActivationEditor(page: Extract<SubPage, { kind: "activation" }>) {
    const t = this.localize.t.bind(this.localize);
    const back = () => this._open({ kind: "list" });
    return html`
      ${this._head(t("rules_activation"), this.plan.name, back)}
      <div class="panel">
        <div class="field">
          <span class="label">${t("plan_runs_when")}</span>
          ${this._segmented(page.match, (v) => (this._page = { ...page, match: v }), t("combine"), true)}
        </div>
        <zeitwerk-conditions-editor
          .hass=${this.hass}
          .localize=${this.localize}
          .value=${page.conditions}
          @value-changed=${(ev: CustomEvent<{ value: Condition[] }>) => {
            this._conditionsValid = true;
            this._page = { ...page, conditions: ev.detail.value };
          }}
          @value-invalid=${() => (this._conditionsValid = false)}
        ></zeitwerk-conditions-editor>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      <div class="actions">
        <button class="danger" @click=${back}>${t("cancel")}</button>
        <button
          class="primary"
          ?disabled=${this._busy || !this._conditionsValid}
          @click=${() =>
            this._run((p) => {
              p.activation.match = page.match;
              p.activation.conditions = page.conditions;
            }, back)}
        >
          ${t("save")}
        </button>
      </div>
    `;
  }

  static styles = [
    tokens,
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
        opacity: 0.5;
        cursor: default;
      }
      button:focus-visible,
      select:focus-visible,
      input:focus-visible {
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
      .rsub {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .small {
        font-size: 11px;
      }
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
      .rule {
        display: flex;
        align-items: center;
        min-height: 64px;
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        box-sizing: border-box;
      }
      .rule.dragging {
        position: relative;
        z-index: 1;
        background: var(--zw-surface-2);
      }
      .handle {
        width: 32px;
        align-self: stretch;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--zw-text-2);
        touch-action: none;
        cursor: grab;
      }
      .rule-main {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px 8px 0;
        text-align: left;
      }
      .ricon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        --mdc-icon-size: 18px;
      }
      .rtext {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .rtitle {
        font-size: 14px;
        font-weight: 600;
      }
      .rsub {
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .badge {
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 10px;
        background: var(--zw-surface);
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .add {
        height: 48px;
        border-radius: 22px;
        border: 1px dashed var(--zw-surface-2);
        border-color: color-mix(in srgb, var(--zw-text) 22%, transparent);
        font-size: 14px;
        font-weight: 500;
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
      .between {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .label {
        font-size: 14px;
        font-weight: 500;
      }
      .ltext {
        display: flex;
        flex-direction: column;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .field .label {
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
      }
      .segmented {
        display: flex;
        gap: 4px;
        padding: 3px;
        border-radius: 18px;
        background: var(--zw-surface);
      }
      .segmented button {
        height: 32px;
        padding: 0 12px;
        border-radius: 15px;
        font-size: 12px;
        font-weight: 600;
      }
      .segmented.wide button {
        flex: 1;
        height: 36px;
      }
      .segmented button[aria-checked="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
      }
      .cond {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 0 12px;
        border-radius: 16px;
        background: var(--zw-surface);
      }
      .check {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
      }
      .check.ok,
      .cstate.ok {
        color: var(--zw-ok);
      }
      .check.ok {
        background: color-mix(in srgb, var(--zw-ok) 18%, transparent);
      }
      .check.bad,
      .cstate.bad {
        color: var(--zw-danger);
      }
      .check.bad {
        background: color-mix(in srgb, var(--zw-danger) 18%, transparent);
      }
      .ctext {
        flex: 1;
        font-size: 13px;
      }
      .cstate {
        font-size: 12px;
      }
      .secondary {
        height: 40px;
        border-radius: 20px;
        background: var(--zw-surface-2);
        font-size: 13px;
        font-weight: 600;
      }
      select,
      input[type="text"] {
        font: inherit;
        font-size: 13px;
        color: var(--zw-text);
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        border-radius: 12px;
        padding: 8px 10px;
      }
      select option {
        color: initial;
      }
      input[type="text"] {
        font-size: 15px;
        height: 44px;
        box-sizing: border-box;
      }
      .switch {
        position: relative;
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
      .switch[aria-checked="true"] {
        background: var(--zw-accent);
        justify-content: flex-end;
      }
      .switch[aria-checked="true"] span {
        background: var(--zw-on-accent);
      }
      .profiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: 8px;
      }
      .profile {
        height: 48px;
        border-radius: 18px;
        border: 2px solid;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 5px;
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
      .actions button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
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
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-rules": ZeitwerkRules;
  }
}
