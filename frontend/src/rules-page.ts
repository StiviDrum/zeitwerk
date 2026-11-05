/**
 * Rules page of a plan (docs/mockup/Regeln.dc.html): overrides with priority
 * (drag to sort), activation conditions, and the editors for both.
 *
 * Editors are in-card sub-pages, not modal dialogs: HA's condition editor
 * opens its own dialogs at the document root, which a modal <dialog> would
 * make inert.
 */
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { profileColor, tint } from "./colors";
import {
  conditionSummary,
  conditionsSummary,
  moveItem,
  uniqueId,
  type Condition,
} from "./conditions";
import type { Localizer } from "./localize";
import { pageStyles, tokens } from "./styles";
import { WEEKDAYS, type HomeAssistant, type Override, type Plan, type Weekday } from "./types";

export type PlanMutator = (plan: Plan) => void;

type HelpKey = "help_overrides" | "help_activation" | "help_holidays";

type SubPage =
  | { kind: "menu" }
  | { kind: "overrides" }
  | { kind: "activation" }
  | { kind: "holidays" }
  | { kind: "duplicate"; name: string }
  | { kind: "plan-edit"; name: string; icon: string; tags: string; confirmDelete: boolean }
  | { kind: "override"; index: number; draft: Override }
  | { kind: "activation-edit"; match: "all" | "any"; conditions: Condition[] };

const ROW_PITCH = 72; // 64 px row + 8 px gap

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

export class ZeitwerkRules extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public save!: (mutate: PlanMutator) => Promise<void>;
  /** Copy the plan under a new name (the copy starts switched off). */
  @property({ attribute: false }) public duplicate?: (name: string) => Promise<void>;
  /** Delete the whole plan. */
  @property({ attribute: false }) public deletePlan?: () => Promise<void>;

  @state() private _page: SubPage = { kind: "menu" };
  @state() private _error?: string;
  @state() private _busy = false;
  @state() private _confirmDelete = false;
  @state() private _drag?: { index: number; startY: number; dy: number };
  @state() private _conditionsValid = true;
  /** Open explanation (keys joined), toggled by the "?" buttons. */
  @state() private _help?: string;
  @state() private _upcoming?: { date: string; name: string }[] | null;
  private _upcomingFor?: string | null;

  protected updated(): void {
    const source = this.plan?.holidays.source ?? null;
    if (this._page.kind === "holidays" && source !== this._upcomingFor) {
      this._upcomingFor = source;
      this._upcoming = undefined;
      if (source && this.hass) {
        this.hass
          .callWS<{ holidays: { date: string; name: string }[] }>({
            type: "zeitwerk/holidays/upcoming",
            source,
          })
          .then((r) => {
            if (this._upcomingFor === source) this._upcoming = r.holidays;
          })
          .catch(() => {
            if (this._upcomingFor === source) this._upcoming = null;
          });
      }
    }
  }

  /** Holiday calendars and Workday sensors known to Home Assistant. */
  private _holidaySources(): string[] {
    const states = this.hass?.states ?? {};
    return Object.keys(states)
      .filter(
        (id) =>
          id.startsWith("calendar.") ||
          (id.startsWith("binary_sensor.") && Array.isArray(states[id].attributes.workdays)),
      )
      .sort();
  }

  private _setHolidays(changes: Partial<Plan["holidays"]>): void {
    const t = this.localize.t.bind(this.localize);
    this._run((p) => {
      Object.assign(p.holidays, changes);
      if (!p.holidays.source) p.holidays.mode = "off";
      if (p.holidays.mode === "like_day" && !p.holidays.like_day) p.holidays.like_day = "sun";
      if (p.holidays.mode === "own_day_type") {
        let dt = p.week.day_types.find((d) => d.id === p.holidays.day_type && !d.days.length);
        if (!dt) {
          dt = p.week.day_types.find((d) => !d.days.length);
        }
        if (!dt) {
          dt = {
            id: uniqueId(
              "holiday",
              p.week.day_types.map((d) => d.id),
            ),
            name: t("holiday"),
            days: [],
            blocks: [],
          };
          p.week.day_types.push(dt);
        }
        p.holidays.day_type = dt.id;
      }
    });
  }

  private _renderHolidays() {
    const t = this.localize.t.bind(this.localize);
    const l = this.localize;
    const h = this.plan.holidays;
    const sources = this._holidaySources();
    if (h.source && !sources.includes(h.source)) sources.unshift(h.source);
    const modes: ["off" | "like_day" | "own_day_type", string][] = [
      ["off", t("holiday_mode_off")],
      ["like_day", t("holiday_mode_like")],
      ["own_day_type", t("holiday_mode_own")],
    ];
    const fmtDate = (iso: string) => {
      const d = new Date(`${iso}T12:00:00`);
      const wd = l.weekdayShort((d.getDay() + 6) % 7);
      return `${wd} ${d.toLocaleDateString(l.lang, { day: "2-digit", month: "2-digit" })}`;
    };
    return html`<div class="panel">
      <label class="between">
        <span class="label">${t("holiday_source")}</span>
        <select
          ?disabled=${this._busy}
          @change=${(ev: Event) =>
            this._setHolidays({ source: (ev.target as HTMLSelectElement).value || null })}
        >
          <option value="" ?selected=${!h.source}>${t("holiday_source_none")}</option>
          ${sources.map(
            (id) =>
              html`<option value=${id} ?selected=${id === h.source}>
                ${String(this.hass?.states[id]?.attributes.friendly_name ?? id)}
              </option>`,
          )}
        </select>
      </label>
      <div class="segmented wide" role="radiogroup" aria-label=${t("holiday_mode")}>
        ${modes.map(
          ([mode, label]) =>
            html`<button
              role="radio"
              aria-checked=${h.mode === mode ? "true" : "false"}
              ?disabled=${this._busy || (!h.source && mode !== "off")}
              @click=${() => h.mode !== mode && this._setHolidays({ mode })}
            >
              ${label}
            </button>`,
        )}
      </div>
      ${
        h.mode === "like_day"
          ? html`<label class="between">
              <span class="label">${t("holiday_like_day")}</span>
              <select
                ?disabled=${this._busy}
                @change=${(ev: Event) =>
                  this._setHolidays({
                    like_day: (ev.target as HTMLSelectElement).value as Weekday,
                  })}
              >
                ${WEEKDAYS.map(
                  (wd, i) =>
                    html`<option value=${wd} ?selected=${wd === h.like_day}>
                      ${l.weekdayLong(i)}
                    </option>`,
                )}
              </select>
            </label>`
          : nothing
      }
      ${
        h.source
          ? html`<div class="field">
              <span class="label">${t("holiday_next")}</span>
              ${
                this._upcoming === undefined
                  ? html`<span class="muted">…</span>`
                  : this._upcoming?.length
                    ? this._upcoming.map(
                        (u) =>
                          html`<div class="between hday">
                            <span>${u.name || t("holiday")}</span
                            ><span class="muted">${fmtDate(u.date)}</span>
                          </div>`,
                      )
                    : html`<span class="muted">${t("holiday_none_upcoming")}</span>`
              }
              ${
                h.source.startsWith("binary_sensor.")
                  ? html`<span class="muted small">${t("holiday_workday_hint")}</span>`
                  : nothing
              }
            </div>`
          : nothing
      }
    </div>`;
  }

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
      case "activation-edit":
        return this._renderActivationEditor(this._page);
      case "overrides":
        return this._renderOverrides();
      case "activation":
        return this._renderActivation();
      case "holidays":
        return this._renderHolidayPage();
      case "duplicate":
        return this._renderDuplicate(this._page);
      case "plan-edit":
        return this._renderPlanEdit(this._page);
      default:
        return this._renderMenu();
    }
  }

  /** "?" button toggling explanations; native tooltip on hover. */
  private _helpButton(keys: HelpKey[]) {
    const t = this.localize.t.bind(this.localize);
    const id = keys.join(",");
    const open = this._help === id;
    return html`<button
      class="help"
      aria-label=${t("help")}
      aria-expanded=${open ? "true" : "false"}
      title=${keys.map((k) => t(k)).join("\n\n")}
      @click=${() => (this._help = open ? undefined : id)}
    >
      ?
    </button>`;
  }

  private _helpText(keys: HelpKey[]) {
    if (this._help !== keys.join(",")) return nothing;
    const t = this.localize.t.bind(this.localize);
    return html`<div class="helptext" role="note">${keys.map((k) => html`<p>${t(k)}</p>`)}</div>`;
  }

  private _head(title: string, sub: string, back: () => void, help?: HelpKey[]) {
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
          <span class="title">${title}${help ? this._helpButton(help) : nothing}</span>
          <span class="sub">${sub}</span>
        </div>
      </div>
      ${help ? this._helpText(help) : nothing}`;
  }

  private _separator(title: string, hint?: string, help?: HelpKey[]) {
    return html`<div class="separator">
        <span>${title}</span>${hint ? html`<span class="shint">${hint}</span>` : nothing}${
          help ? this._helpButton(help) : nothing
        }<span class="line"></span>
      </div>
      ${help ? this._helpText(help) : nothing}`;
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

  private _renderMenu() {
    const t = this.localize.t.bind(this.localize);
    const plan = this.plan;
    const results = plan.status?.override_results ?? {};
    const active = plan.overrides.filter((o) => results[o.id]);
    const overrides = plan.overrides.length
      ? `${plan.overrides.map((o) => o.name).join(", ")} · ${
          active.length
            ? active.map((o) => t("override_active", { name: o.name })).join(", ")
            : t("none_active")
        }`
      : t("no_conditions");
    const act = plan.activation;
    const activation = act.conditions.length
      ? `${conditionsSummary(act.conditions, act.match, this.hass, this.localize)} · ${
          plan.status?.active ? t("fulfilled") : t("not_fulfilled")
        }`
      : t("always_runs");
    const h = plan.holidays;
    const holidays =
      h.mode === "off" || !h.source
        ? t("holiday_mode_off")
        : `${String(this.hass?.states[h.source]?.attributes.friendly_name ?? h.source)} · ${
            h.mode === "like_day"
              ? t("holiday_like", {
                  day: this.localize.weekdayLong(WEEKDAYS.indexOf(h.like_day ?? "sun")),
                })
              : t("holiday_mode_own")
          }`;
    const row = (icon: string, title: string, sub: string, open: () => void) =>
      html`<button class="menu-row" @click=${open}>
        <span class="ricon neutral"><ha-icon .icon=${icon}></ha-icon></span>
        <span class="rtext"
          ><span class="rtitle">${title}</span><span class="rsub">${sub}</span></span
        >
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
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>`;
    return html`
      ${this._head(t("config_title"), plan.name, () => this._fire("zw-back"))}
      ${this._separator(t("section_rules"), undefined, [
        "help_overrides",
        "help_activation",
        "help_holidays",
      ])}
      <div class="menu">
        ${row("mdi:layers-outline", t("rules_overrides"), overrides, () => this._open({ kind: "overrides" }))}
        ${row("mdi:flash-outline", t("rules_activation"), activation, () => this._open({ kind: "activation" }))}
        ${row("mdi:flag-outline", t("rules_holidays"), holidays, () => this._open({ kind: "holidays" }))}
      </div>
      ${this._separator(t("section_plan"))}
      <div class="menu">
        ${row("mdi:pencil-outline", t("edit_plan"), t("edit_plan_sub"), () => {
          if (!this._admin) {
            this._error = t("admin_only");
            return;
          }
          this._open({
            kind: "plan-edit",
            name: plan.name,
            icon: plan.icon ?? "",
            tags: plan.tags.join(", "),
            confirmDelete: false,
          });
        })}
        ${
          this.duplicate
            ? row("mdi:content-copy", t("duplicate_plan"), t("duplicate_sub"), () => {
                if (!this._admin) {
                  this._error = t("admin_only");
                  return;
                }
                this._open({ kind: "duplicate", name: `${plan.name} (${t("copy_suffix")})` });
              })
            : nothing
        }
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
    `;
  }

  private _renderPlanEdit(page: Extract<SubPage, { kind: "plan-edit" }>) {
    const t = this.localize.t.bind(this.localize);
    const set = (changes: Partial<typeof page>) => {
      Object.assign(page, changes);
      this._error = undefined;
      this.requestUpdate();
    };
    const save = () => {
      if (!page.name.trim()) {
        this._error = t("name_required");
        return;
      }
      this._run(
        (p) => {
          p.name = page.name.trim();
          p.icon = page.icon.trim() || null;
          p.tags = page.tags
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        },
        () => this._open({ kind: "menu" }),
      );
    };
    const remove = async () => {
      if (!this.deletePlan) return;
      this._busy = true;
      this._error = undefined;
      try {
        await this.deletePlan();
      } catch (err) {
        this._error = t("save_failed", { error: errorText(err) });
      } finally {
        this._busy = false;
      }
    };
    return html`
      ${this._head(t("edit_plan"), this.plan.name, () => this._open({ kind: "menu" }))}
      <div class="panel">
        <label class="field">
          <span class="label">${t("name")}</span>
          <input
            type="text"
            .value=${page.name}
            @input=${(ev: Event) => set({ name: (ev.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field">
          <span class="label">${t("icon")}</span>
          ${
            customElements.get("ha-icon-picker") && this.hass
              ? html`<ha-icon-picker
                  .hass=${this.hass}
                  .value=${page.icon}
                  @value-changed=${(ev: CustomEvent<{ value?: string }>) => {
                    ev.stopPropagation();
                    set({ icon: ev.detail.value ?? "" });
                  }}
                ></ha-icon-picker>`
              : html`<input
                  type="text"
                  placeholder="mdi:…"
                  .value=${page.icon}
                  @input=${(ev: Event) => set({ icon: (ev.target as HTMLInputElement).value })}
                />`
          }
        </label>
        <label class="field">
          <span class="label">${t("tags")}</span>
          <input
            type="text"
            .value=${page.tags}
            @input=${(ev: Event) => set({ tags: (ev.target as HTMLInputElement).value })}
          />
        </label>
        <span class="muted">${t("plan_id_hint", { id: this.plan.id })}</span>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      <div class="actions">
        <button class="danger" @click=${() => this._open({ kind: "menu" })}>${t("cancel")}</button>
        <button class="primary" ?disabled=${this._busy} @click=${save}>${t("save")}</button>
      </div>
      ${
        this.deletePlan
          ? page.confirmDelete
            ? html`<div class="confirm-box" role="alert">
                <span>${t("delete_plan_confirm", { name: this.plan.name })}</span>
                <div class="actions">
                  <button class="secondary grow" @click=${() => set({ confirmDelete: false })}>
                    ${t("cancel")}
                  </button>
                  <button class="danger-fill grow" ?disabled=${this._busy} @click=${remove}>
                    ${t("delete_plan")}
                  </button>
                </div>
              </div>`
            : html`<button class="text-danger" @click=${() => set({ confirmDelete: true })}>
                ${t("delete_plan")}
              </button>`
          : nothing
      }
    `;
  }

  private _renderDuplicate(page: { kind: "duplicate"; name: string }) {
    const t = this.localize.t.bind(this.localize);
    const create = async () => {
      if (!page.name.trim() || !this.duplicate) return;
      this._busy = true;
      this._error = undefined;
      try {
        await this.duplicate(page.name.trim());
        this._open({ kind: "menu" });
      } catch (err) {
        this._error = t("save_failed", { error: errorText(err) });
      } finally {
        this._busy = false;
      }
    };
    return html`
      ${this._head(t("duplicate_plan"), this.plan.name, () => this._open({ kind: "menu" }))}
      <div class="panel">
        <label class="field">
          <span class="label">${t("name")}</span>
          <input
            type="text"
            .value=${page.name}
            @input=${(ev: Event) => {
              page.name = (ev.target as HTMLInputElement).value;
              this.requestUpdate();
            }}
          />
        </label>
        <span class="muted">${t("duplicate_hint")}</span>
      </div>
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      <div class="actions">
        <button class="danger" @click=${() => this._open({ kind: "menu" })}>${t("cancel")}</button>
        <button class="primary" ?disabled=${this._busy || !page.name.trim()} @click=${create}>
          ${t("duplicate_create")}
        </button>
      </div>
    `;
  }

  private _renderOverrides() {
    const t = this.localize.t.bind(this.localize);
    const plan = this.plan;
    const results = plan.status?.override_results ?? {};
    return html`
      ${this._head(t("rules_overrides"), plan.name, () => this._open({ kind: "menu" }), [
        "help_overrides",
      ])}
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

      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
    `;
  }

  private _renderActivation() {
    const t = this.localize.t.bind(this.localize);
    const plan = this.plan;
    const activation = plan.activation;
    const actResults = plan.status?.activation_results ?? [];
    return html`
      ${this._head(t("rules_activation"), plan.name, () => this._open({ kind: "menu" }), [
        "help_activation",
      ])}
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
              kind: "activation-edit",
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

  private _renderHolidayPage() {
    return html`
      ${this._head(
        this.localize.t("rules_holidays"),
        this.plan.name,
        () => this._open({ kind: "menu" }),
        ["help_holidays"],
      )}
      ${this._renderHolidays()}
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
    const back = () => this._open({ kind: "overrides" });
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

  private _renderActivationEditor(page: Extract<SubPage, { kind: "activation-edit" }>) {
    const t = this.localize.t.bind(this.localize);
    const back = () => this._open({ kind: "activation" });
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
      .title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .help {
        width: 26px;
        height: 26px;
        border-radius: 13px;
        background: var(--zw-surface-2);
        font-size: 14px;
        font-weight: 700;
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .help[aria-expanded="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
      }
      .helptext {
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        font-size: 13px;
        line-height: 1.45;
      }
      .helptext p {
        margin: 0;
      }
      .helptext p + p {
        margin-top: 8px;
      }
      .menu {
        display: flex;
        flex-direction: column;
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        overflow: hidden;
      }
      .menu-row {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 64px;
        padding: 10px 14px 10px 10px;
        text-align: left;
      }
      .menu-row + .menu-row {
        border-top: 1px solid var(--zw-border);
      }
      .menu-row svg {
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .ricon.neutral {
        background: var(--zw-surface-2);
      }
      .hday {
        font-size: 13px;
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
      .confirm-box {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border-radius: 16px;
        font-size: 14px;
        background: color-mix(in srgb, var(--zw-danger) 10%, transparent);
      }
      .confirm-box .actions button {
        height: 44px;
      }
      .grow {
        flex: 1;
      }
      .text-danger {
        align-self: flex-start;
        min-height: 40px;
        font-size: 14px;
        font-weight: 600;
        color: var(--zw-danger);
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
    "zeitwerk-rules": ZeitwerkRules;
  }
}
