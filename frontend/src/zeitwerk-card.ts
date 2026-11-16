import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ZeitwerkCardEditor } from "./card-editor";
import { NowClock } from "./clock";
import { profileColor, textOn, tint } from "./colors";
import { syncDark } from "./display-ui";
import { localizer, type Localizer } from "./localize";
import { linkClick, navigateTo, routePath } from "./nav";
import { ZeitwerkPlanHeader } from "./plan-header";
import {
  errorMessage,
  languageOf,
  stripStatus,
  valueLabel,
  watchedEntities,
  type ViewCtx,
} from "./plan-view";
import {
  controlFor,
  formatValue,
  fraction,
  quickValue,
  snapValue,
  toggledActions,
  type Control,
  type QuickValue,
} from "./quickview";
import { defineElements } from "./register";
import { tokens } from "./styles";
import { ZeitwerkTimelinePlan, type ScheduledSegment } from "./timeline-plan";
import { formatTime, zonedNow } from "./time";
import type { HomeAssistant, Plan, PlanEvent, Profile, ZeitwerkCardConfig } from "./types";
import { CARD_VERSION } from "./version";
import { RetrySubscription } from "./subscription";
import { ZeitwerkWeekGrid } from "./week-grid";
import type { DayKey } from "./day-plan";
import type { TemplateResult } from "lit";

const VALUE_DEBOUNCE_MS = 400;
const SLIDER_HOLD_MS = 350;
const NOTICE_MS = 4000;
const UNDO_MS = 10_000;

interface QuickRow {
  profile: Profile;
  qv: QuickValue;
  control: Control;
}

/**
 * Lovelace card: shows the current profile/value, the read-only week grid or
 * the timeline and offers manual control. Editing lives in the Zeitwerk panel.
 */
export class ZeitwerkCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: ZeitwerkCardConfig;
  @state() private _plan?: Plan | null;
  @state() private _error?: string;
  /** Profile id of the slider that is being dragged after a hold. */
  @state() private _armed?: string;
  private _slider?: {
    x: number;
    y: number;
    x0: number;
    y0: number;
    rect: DOMRect;
    armed: boolean;
    timer?: number;
  };
  @state() private _notice?: string;
  /** Slider values not yet confirmed by the backend, per profile id. */
  @state() private _pending: Record<string, number | string> = {};
  /** Timeline view: id of the plan opened in the full week view. */
  @state() private _detail?: string;
  /** Last change made in this card, offered for undo for a few seconds. */
  @state() private _undo?: { before: Plan; after: string };
  private _undoTimer?: number;
  /** Plan before the current series of slider changes (one undo step). */
  private _sliderBefore?: Plan;
  private _sliderUndo?: { before: Plan; profileId: string; value: number | string };
  /** Timeline view: all (tag-filtered) plans and today's scheduled segments. */
  @state() private _plans?: Plan[];
  @state() private _segments: Record<string, ScheduledSegment[]> = {};
  private _previewTimer?: number;
  private _watched?: { source: unknown; ids: string[] };

  private _sub?: RetrySubscription<PlanEvent>;
  private _subscribedPlan?: string;
  private _clock = new NowClock(
    this,
    () => this.hass?.config?.time_zone,
    ({ minutes, dayChanged }) => {
      if (dayChanged) {
        this.requestUpdate();
        if (this._config?.view === "timeline") this._schedulePreview(0);
      }
      const clock = this.renderRoot?.querySelector<HTMLElement>(".tl-clock");
      if (clock) clock.textContent = formatTime(minutes);
    },
  );
  private _valueTimers: Record<string, number> = {};
  private _noticeTimer?: number;

  // --- Lovelace API ---------------------------------------------------------

  public setConfig(config: ZeitwerkCardConfig): void {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    // `time_step` is a plan option now; the key is still accepted and ignored.
    this._config = { view: "week", show_profile_sliders: true, ...config };
    if (this._subscribedPlan !== this._config.plan) this._resubscribe();
  }

  public getCardSize(): number {
    return this._config?.compact ? 6 : 10;
  }

  public getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  public static getConfigElement(): HTMLElement {
    return document.createElement("zeitwerk-card-editor");
  }

  public static async getStubConfig(hass?: HomeAssistant): Promise<Partial<ZeitwerkCardConfig>> {
    try {
      const res = await hass?.callWS<{ plans: Plan[] }>({ type: "zeitwerk/plans/list" });
      const first = res?.plans[0];
      if (first) return { view: "week", plan: first.id };
    } catch {
      // Integration not set up – the card shows a friendly hint instead.
    }
    return { view: "week" };
  }

  // --- Lifecycle ------------------------------------------------------------

  public connectedCallback(): void {
    super.connectedCallback();
    this._clock.start();
    if (this.hass && this._config) this._resubscribe();
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe();
    this._clock.stop();
    window.clearTimeout(this._previewTimer);
    window.clearTimeout(this._noticeTimer);
    window.clearTimeout(this._undoTimer);
    this._sliderEnd();
    Object.values(this._valueTimers).forEach((t) => window.clearTimeout(t));
    this._valueTimers = {};
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const old = changed.get("hass") as HomeAssistant | undefined;
    if (!old || !this.hass) return true;
    if (
      old.language !== this.hass.language ||
      old.locale?.language !== this.hass.locale?.language ||
      old.themes?.darkMode !== this.hass.themes?.darkMode ||
      old.user?.is_admin !== this.hass.user?.is_admin
    ) {
      return true;
    }
    return this._watchedEntities().some((id) => old.states[id] !== this.hass!.states[id]);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass) {
      syncDark(this, this.hass);
      if (!this._sub && this._subscribedPlan === undefined && this._config && this.isConnected) {
        this._resubscribe();
      }
    }
  }

  protected updated(): void {
    this._clock.update();
  }

  /** Entities whose state changes are relevant for rendering (DESIGN.md §3). */
  private _watchedEntities(): string[] {
    // Checked on every hass update: compute once per plan (list) object.
    const timeline = this._config?.view === "timeline" && !this._detail;
    const source = timeline ? this._plans : this._plan;
    const cached = this._watched;
    if (cached && cached.source === source) return cached.ids;
    const plans = timeline ? (this._plans ?? []) : this._plan ? [this._plan] : [];
    const ids = [...new Set(plans.flatMap((p) => watchedEntities(p, !timeline)))];
    this._watched = { source, ids };
    return ids;
  }

  // --- Data -----------------------------------------------------------------

  private _unsubscribe(): void {
    this._sub?.stop();
    this._sub = undefined;
    this._subscribedPlan = undefined;
  }

  private _start(msg: Record<string, unknown>, onEvent: (event: PlanEvent) => void): void {
    const sub = new RetrySubscription<PlanEvent>({
      hass: () => this.hass,
      msg,
      onEvent,
      onError: (err) => {
        if (this._sub !== sub) return;
        if (!err) this._error = undefined;
        else if ((err as { code?: string }).code === "not_found") this._plan = null;
        else this._error = errorMessage(err);
      },
    });
    this._sub = sub;
    sub.start();
  }

  private _retry = (): void => this._sub?.retryNow();

  private _resubscribe(): void {
    this._unsubscribe();
    this._detail = undefined;
    this._plan = undefined;
    this._plans = undefined;
    this._error = undefined;
    if (this._config?.view === "timeline") {
      this._subscribeAll();
      return;
    }
    const planId = this._config?.plan;
    const view = this._config?.view;
    if (!this.hass?.connection || !planId || (view !== "week" && view !== "profiles")) return;
    if (!this.isConnected) return;
    this._subscribedPlan = planId;
    this._start({ type: "zeitwerk/plans/subscribe", plan_id: planId }, (msg) => this._onEvent(msg));
  }

  private _subscribeAll(): void {
    if (!this.hass?.connection || !this.isConnected) return;
    this._subscribedPlan = "*";
    this._start({ type: "zeitwerk/plans/subscribe" }, (msg) => {
      let plans = this._plans ?? [];
      if (msg.event === "init") plans = msg.plans ?? [];
      else if (msg.event === "removed") plans = plans.filter((p) => p.id !== msg.plan_id);
      else if (msg.plan) {
        const plan = msg.plan;
        const i = plans.findIndex((p) => p.id === msg.plan_id);
        plans = i < 0 ? [...plans, plan] : plans.map((p, j) => (j === i ? plan : p));
      }
      this._plans = plans;
      if (this._detail) {
        this._plan = plans.find((p) => p.id === this._detail) ?? null;
        if (this._plan) this._planUpdated();
        else this._closeDetail();
      }
      this._schedulePreview(msg.event === "init" ? 0 : 1000);
    });
  }

  /** Plans of the timeline: the chosen ones (in that order) or all, then the tag filter. */
  private _timelinePlans(): Plan[] {
    const ids = this._config?.plans ?? [];
    const tags = this._config?.tags ?? [];
    const all = this._plans ?? [];
    const plans = ids.length
      ? ids.map((id) => all.find((p) => p.id === id)).filter((p): p is Plan => !!p)
      : all;
    return tags.length ? plans.filter((p) => p.tags.some((t) => tags.includes(t))) : plans;
  }

  /** Timeline: open one plan in the full week view (same card). */
  private _openDetail(planId: string): void {
    const plan = this._plans?.find((p) => p.id === planId);
    if (!plan) return;
    this._detail = plan.id;
    this._plan = plan;
    this._pending = {};
  }

  private _closeDetail = (): void => {
    this._detail = undefined;
    this._plan = undefined;
    this._pending = {};
  };

  /** Fetch today's scheduled segments (debounced; plan edits change them). */
  private _schedulePreview(delay: number): void {
    window.clearTimeout(this._previewTimer);
    this._previewTimer = window.setTimeout(() => {
      const ids = this._timelinePlans().map((p) => p.id);
      if (!this.hass || !ids.length) return;
      this.hass
        .callWS<{ plans: Record<string, ScheduledSegment[]> }>({
          type: "zeitwerk/preview",
          plan_ids: ids,
        })
        .then((r) => (this._segments = r.plans))
        .catch(() => undefined);
    }, delay);
  }

  private _onEvent(msg: PlanEvent): void {
    const planId = this._config?.plan;
    if (msg.event === "init") {
      this._plan = msg.plans?.find((p) => p.id === planId) ?? null;
    } else if (msg.plan_id === planId) {
      this._plan = msg.event === "removed" ? null : (msg.plan ?? null);
    }
    if (this._plan) this._planUpdated();
  }

  /** A new version of the shown plan arrived from the backend. */
  private _planUpdated(): void {
    if (this._plan) {
      // Values confirmed by the backend replace the optimistic slider values.
      const pending = { ...this._pending };
      for (const p of this._plan.profiles) {
        const qv = quickValue(p);
        if (qv?.kind === "value" && pending[p.id] === qv.value && !this._valueTimers[p.id]) {
          delete pending[p.id];
        }
      }
      this._pending = pending;
      this._checkSliderUndo();
    }
  }

  private async _updatePlan(mutate: (plan: Plan) => void): Promise<void> {
    if (!this.hass || !this._plan) return;
    const before = stripStatus(this._plan);
    const plan = structuredClone(before);
    mutate(plan);
    const saved = await this.hass.callWS<Plan>({
      type: "zeitwerk/plans/update",
      plan_id: plan.id,
      plan,
    });
    this._offerUndo(before, saved);
  }

  /** Show "Gespeichert · Rückgängig" for a change from `before` to `after`. */
  private _offerUndo(before: Plan, after: Plan | undefined | null): void {
    if (!after) return;
    window.clearTimeout(this._undoTimer);
    this._notice = undefined;
    this._undo = { before, after: JSON.stringify(stripStatus(after)) };
    this._undoTimer = window.setTimeout(() => (this._undo = undefined), UNDO_MS);
  }

  private _doUndo = async (): Promise<void> => {
    const undo = this._undo;
    window.clearTimeout(this._undoTimer);
    this._undo = undefined;
    if (!undo || !this.hass || !this._plan) return;
    const l = this._l;
    if (JSON.stringify(stripStatus(this._plan)) !== undo.after) {
      this._notify(l.t("undo_conflict"));
      return;
    }
    try {
      await this.hass.callWS({
        type: "zeitwerk/plans/update",
        plan_id: undo.before.id,
        plan: undo.before,
      });
      this._notify(l.t("undone"));
    } catch (err) {
      this._notify(l.t("save_failed", { error: errorMessage(err) }));
    }
  };

  /** Offer undo for slider changes once the backend confirmed the value. */
  private _checkSliderUndo(): void {
    const pending = this._sliderUndo;
    if (!pending || !this._plan) return;
    if (this._plan.id !== pending.before.id) {
      this._sliderUndo = undefined;
      return;
    }
    const profile = this._plan.profiles.find((p) => p.id === pending.profileId);
    const qv = profile ? quickValue(profile) : null;
    if (qv?.kind === "value" && qv.value === pending.value) {
      this._sliderUndo = undefined;
      this._offerUndo(pending.before, this._plan);
    }
  }

  private _renderUndo() {
    if (!this._undo) return nothing;
    const l = this._l;
    return html`<div class="notice undo" role="status">
      <span>${l.t("saved")}</span>
      <button class="undo-btn" @click=${this._doUndo}>${l.t("undo")}</button>
    </div>`;
  }

  private _notify(text: string, ms = NOTICE_MS): void {
    this._notice = text;
    window.clearTimeout(this._noticeTimer);
    this._noticeTimer = window.setTimeout(() => (this._notice = undefined), ms);
  }

  private _onNotice = (ev: CustomEvent<string>): void => {
    ev.stopPropagation();
    this._notify(ev.detail);
  };

  // --- Helpers --------------------------------------------------------------

  private get _l(): Localizer {
    return localizer(languageOf(this.hass));
  }

  private get _ctx(): ViewCtx {
    return { hass: this.hass, l: this._l };
  }

  private get _admin(): boolean {
    return !!this.hass?.user?.is_admin;
  }

  private _quick(profile: Profile): QuickRow | null {
    const qv = quickValue(profile);
    if (!qv) return null;
    const entity = this.hass?.states[qv.entityId];
    const unit = this.hass?.config?.unit_system?.temperature ?? "°C";
    const control = controlFor(qv, entity, unit);
    const pending = this._pending[profile.id];
    const shown: QuickValue =
      pending !== undefined && qv.kind === "value" ? { ...qv, value: pending } : qv;
    return { profile, qv: shown, control };
  }

  // --- Actions --------------------------------------------------------------

  private _openDay = (ev: CustomEvent<DayKey>): void => {
    if (!this._plan || !this._admin) return;
    navigateTo({ name: "day", planId: this._plan.id, day: ev.detail });
  };

  // Profile slider: on touch it only reacts after a short hold, so scrolling
  // the dashboard does not change values.

  private _sliderValue(row: QuickRow, clientX: number, rect: DOMRect): void {
    if (row.control.type !== "number") return;
    const { min, max, step } = row.control;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    this._setValue(row, snapValue(min + f * (max - min), min, max, step));
  }

  private _sliderDown(row: QuickRow, ev: PointerEvent): void {
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    window.clearTimeout(this._slider?.timer);
    const arm = () => {
      if (!this._slider) return;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        // pointer already gone
      }
      this._slider.armed = true;
      this._armed = row.profile.id;
      if (ev.pointerType !== "mouse") navigator.vibrate?.(10);
      this._sliderValue(row, this._slider.x, rect);
    };
    this._slider = {
      x: ev.clientX,
      y: ev.clientY,
      x0: ev.clientX,
      y0: ev.clientY,
      rect,
      armed: false,
    };
    if (ev.pointerType === "mouse") arm();
    else this._slider.timer = window.setTimeout(arm, SLIDER_HOLD_MS);
  }

  private _sliderMove(row: QuickRow, ev: PointerEvent): void {
    const s = this._slider;
    if (!s) return;
    s.x = ev.clientX;
    if (s.armed) {
      ev.preventDefault();
      this._sliderValue(row, ev.clientX, s.rect);
    } else if (Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0) > 8) {
      this._sliderEnd(); // moving before the hold = scrolling
    }
  }

  private _sliderEnd = (): void => {
    window.clearTimeout(this._slider?.timer);
    this._slider = undefined;
    this._armed = undefined;
  };

  private _sliderKey(row: QuickRow, ev: KeyboardEvent): void {
    if (row.control.type !== "number" || row.qv.kind !== "value") return;
    const { min, max, step } = row.control;
    const v = Number(row.qv.value);
    const map: Record<string, number> = {
      ArrowLeft: v - step,
      ArrowDown: v - step,
      ArrowRight: v + step,
      ArrowUp: v + step,
      Home: min,
      End: max,
    };
    if (!(ev.key in map)) return;
    ev.preventDefault();
    this._setValue(row, snapValue(map[ev.key], min, max, step));
  }

  private _setValue(row: QuickRow, value: number | string): void {
    if (!this.hass || !this._plan || row.qv.kind !== "value") return;
    const profileId = row.profile.id;
    this._pending = { ...this._pending, [profileId]: value };
    window.clearTimeout(this._valueTimers[profileId]);
    const planId = this._plan.id;
    const entityId = row.qv.entityId;
    this._sliderBefore ??= stripStatus(this._plan);
    this._valueTimers[profileId] = window.setTimeout(() => {
      delete this._valueTimers[profileId];
      this.hass
        ?.callService("zeitwerk", "set_profile_value", {
          plan: planId,
          profile: profileId,
          value,
          entity_id: entityId,
        })
        .then(() => {
          if (Object.keys(this._valueTimers).length) return;
          const before = this._sliderBefore;
          this._sliderBefore = undefined;
          if (before) {
            this._sliderUndo = { before, profileId, value };
            this._checkSliderUndo();
          }
        })
        .catch((err) => {
          this._sliderBefore = undefined;
          const pending = { ...this._pending };
          delete pending[profileId];
          this._pending = pending;
          this._notify(errorMessage(err));
        });
    }, VALUE_DEBOUNCE_MS);
  }

  private _toggleProfile(row: QuickRow): void {
    if (row.qv.kind !== "toggle") return;
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    const on = !row.qv.on;
    this._updatePlan((plan) => {
      const p = plan.profiles.find((x) => x.id === row.profile.id);
      if (p) p.actions = toggledActions(p, on);
    }).catch((err) => this._notify(errorMessage(err)));
  }
  private _renderSlider(plan: Plan, row: QuickRow) {
    const l = this._l;
    const { profile, qv, control } = row;
    const color = profileColor(plan, profile);
    const isDefault = profile.id === plan.default_profile;
    const value = formatValue(qv, control, l.lang, [l.t("on"), l.t("off")]);
    let fill = 0;
    let input: TemplateResult | typeof nothing = nothing;
    if (control.type === "number" && qv.kind === "value") {
      const n = Number(qv.value);
      fill = fraction(n, control.min, control.max);
      input = html`<div
        class="hit"
        role="slider"
        tabindex="0"
        aria-label=${profile.name}
        aria-valuemin=${control.min}
        aria-valuemax=${control.max}
        aria-valuenow=${n}
        aria-valuetext=${value}
        @pointerdown=${(ev: PointerEvent) => this._sliderDown(row, ev)}
        @pointermove=${(ev: PointerEvent) => this._sliderMove(row, ev)}
        @pointerup=${this._sliderEnd}
        @pointercancel=${this._sliderEnd}
        @keydown=${(ev: KeyboardEvent) => this._sliderKey(row, ev)}
        @contextmenu=${(ev: Event) => ev.preventDefault()}
      ></div>`;
    } else if (control.type === "toggle" && qv.kind === "toggle") {
      fill = qv.on ? 1 : 0;
      input = html`<button
        class="overlay"
        role="switch"
        aria-checked=${qv.on ? "true" : "false"}
        aria-label=${profile.name}
        @click=${() => this._toggleProfile(row)}
      ></button>`;
    } else if (control.type === "select" && qv.kind === "value") {
      fill =
        Math.max(0, control.options.indexOf(String(qv.value)) + 1) /
        Math.max(1, control.options.length);
      input = html`<select
        class="overlay"
        aria-label=${profile.name}
        @change=${(ev: Event) => this._setValue(row, (ev.target as HTMLSelectElement).value)}
      >
        ${control.options.map(
          (o) => html`<option value=${o} ?selected=${o === String(qv.value)}>${o}</option>`,
        )}
      </select>`;
    }
    return html`<div class="slider ${this._armed === profile.id ? "armed" : ""}">
      <div
        class="fill"
        style="width:${fill * 100}%;background:${tint(color, 30)};border-right-color:${color}"
      ></div>
      <div class="slider-content">
        <div class="picon" style="background:${color};color:${textOn(color)}">
          <ha-icon .icon=${profile.icon || "mdi:thermometer"}></ha-icon>
        </div>
        <span class="pname">
          ${profile.name}${isDefault ? html`<span class="muted"> · ${l.t("default_suffix")}</span>` : nothing}
        </span>
        <span class="pvalue">${value}</span>
      </div>
      ${input}
    </div>`;
  }

  // --- Rendering ------------------------------------------------------------

  protected render() {
    if (!this._config) return nothing;
    const l = this._l;
    const view = this._config.view;
    if (view === "timeline") {
      if (this._error)
        return this._message(l.t("not_loaded", { error: this._error }), true, false, true);
      if (!this.hass || this._plans === undefined) return this._message(l.t("loading"));
      if (this._detail && this._plan) return this._renderWeek(this._plan);
      return this._renderTimeline();
    }
    if (view && view !== "week" && view !== "profiles") {
      return this._message(l.t("view_unsupported", { view }));
    }
    if (!this._config.plan) return this._message(l.t("no_plan"), false, true);
    if (this._error)
      return this._message(l.t("not_loaded", { error: this._error }), true, false, true);
    if (!this.hass || this._plan === undefined) return this._message(l.t("loading"));
    if (this._plan === null)
      return this._message(l.t("plan_missing", { plan: this._config.plan }), true, true);
    return view === "profiles" ? this._renderProfiles(this._plan) : this._renderWeek(this._plan);
  }

  private _renderTimeline() {
    const l = this._l;
    const plans = this._timelinePlans();
    const tz = this.hass?.config?.time_zone;
    const now = zonedNow(tz);
    let date: string;
    try {
      date = new Date().toLocaleDateString(l.lang, {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "short",
      });
    } catch {
      date = new Date().toLocaleDateString();
    }
    const tags = this._config?.tags ?? [];
    const title = this._config?.title ?? (tags.length === 1 ? tags[0] : l.t("timeline_title"));
    const running = plans.filter((p) => p.enabled && p.status?.active).length;
    const body = plans.length
      ? plans.map(
          (p) =>
            html`<zeitwerk-timeline-plan
              .hass=${this.hass}
              .plan=${p}
              .localize=${l}
              .segments=${this._segments[p.id] ?? []}
              @zw-open=${(ev: CustomEvent<string>) => this._openDetail(ev.detail)}
              @zw-notice=${this._onNotice}
            ></zeitwerk-timeline-plan>`,
        )
      : html`<div class="message">
          ${tags.length ? l.t("no_plans_tag", { tag: tags.join(", ") }) : l.t("no_plans")}
        </div>`;
    return html`<ha-card class="timeline">
      <div class="tl-head">
        <div class="tl-titles">
          <span class="tl-date">${l.t("today_date", { date })}</span>
          <span class="tl-title">${title}</span>
        </div>
        <span class="tl-clock">${formatTime(now.minutes)}</span>
      </div>
      ${
        plans.length
          ? html`<div class="chips">
                <span class="chip ok"
                  ><span class="dot"></span>${
                    running === 1 ? l.t("plans_running_one") : l.t("plans_running", { n: running })
                  }</span
                >
              </div>
              <div class="axis tl-axis">
                <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
              </div>`
          : nothing
      }
      ${body} ${this._newPlanButton()}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
    </ha-card>`;
  }

  /** Admins get a link to the panel's plan wizard. */
  private _newPlanButton(preset?: string) {
    if (!this._admin) return nothing;
    const path = routePath({ name: "new", preset });
    return html`<a class="textbtn" href=${path} @click=${linkClick(path)}>
      ${this._l.t("new_plan")}
    </a>`;
  }

  private _message(text: string, isError = false, offerWizard = false, retry = false) {
    return html`<ha-card>
      <div class="message ${isError ? "error" : ""}" role=${isError ? "alert" : nothing}>
        <span class="brand">Zeitwerk</span>
        <span>${text}</span>
        ${this._notice ? html`<span class="notice">${this._notice}</span>` : nothing}
        ${offerWizard ? this._newPlanButton(this._config?.plan) : nothing}
        ${
          retry
            ? html`<button class="textbtn" @click=${this._retry}>${this._l.t("retry")}</button>`
            : nothing
        }
      </div>
    </ha-card>`;
  }

  private _separator(title: string) {
    return html`<div class="separator"><span>${title}</span><span class="line"></span></div>`;
  }

  /** Quick view: one slider per profile with a single entity/value. */
  private _quickRows(plan: Plan): QuickRow[] {
    return plan.profiles.map((p) => this._quick(p)).filter((q): q is QuickRow => !!q);
  }

  private _profileChips(plan: Plan) {
    return html`<div class="pchips">
      ${plan.profiles.map(
        (p) =>
          html`<span class="pchip"
            ><span class="swatch" style="background:${profileColor(plan, p)}"></span>${p.name}${
              valueLabel(this._ctx, p, this._pending)
                ? ` · ${valueLabel(this._ctx, p, this._pending)}`
                : ""
            }</span
          >`,
      )}
    </div>`;
  }

  /** `view: profiles`: only the profile values (quick view). */
  private _renderProfiles(plan: Plan) {
    const quick = this._quickRows(plan);
    return html`<ha-card>
      ${this._separator(this._config?.title ?? plan.name)}
      ${
        quick.length
          ? html`<div class="sliders">${quick.map((q) => this._renderSlider(plan, q))}</div>`
          : this._profileChips(plan)
      }
      ${this._renderUndo()}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
    </ha-card>`;
  }

  private _renderWeek(plan: Plan) {
    const compact = !!this._config!.compact;
    const quick = this._config!.show_profile_sliders && !compact ? this._quickRows(plan) : [];
    const l = this._l;
    return html`<ha-card class=${compact ? "compact" : ""}>
      ${
        this._detail
          ? html`<button class="tl-back" @click=${this._closeDetail}>
              <svg
                width="16"
                height="16"
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
              ${this._config!.title ?? l.t("timeline_title")}
            </button>`
          : nothing
      }
      <zeitwerk-plan-header
        .hass=${this.hass}
        .plan=${plan}
        .localize=${l}
        .pending=${this._pending}
        @zw-notice=${this._onNotice}
      ></zeitwerk-plan-header>
      ${compact ? nothing : this._separator(l.t("section_profiles"))}
      ${
        compact
          ? nothing
          : quick.length
            ? html`<div class="sliders">${quick.map((q) => this._renderSlider(plan, q))}</div>`
            : this._profileChips(plan)
      }
      ${this._separator(l.t("section_week"))}
      <zeitwerk-week-grid
        .hass=${this.hass}
        .plan=${plan}
        .localize=${l}
        .compact=${compact}
        .interactive=${this._admin}
        @zw-day=${this._openDay}
      ></zeitwerk-week-grid>
      ${compact ? nothing : this._editLink(plan)} ${this._renderUndo()}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
    </ha-card>`;
  }

  /** "Edit in Zeitwerk" (admins only; the panel is admin-only). */
  private _editLink(plan: Plan) {
    if (!this._admin) return nothing;
    const path = routePath({ name: "plan", planId: plan.id });
    return html`<a class="link settings" href=${path} @click=${linkClick(path)}>
      <span class="licon"><ha-icon .icon=${"mdi:pencil-outline"}></ha-icon></span>
      <span class="ltext">
        <span class="ltitle">${this._l.t("edit_in_zeitwerk")}</span>
      </span>
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
    </a>`;
  }

  static styles = [
    tokens,
    css`
      ha-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
        background: var(--zw-bg);
        border-radius: var(--zw-radius-card);
      }
      .message {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 4px 6px;
        font-size: 14px;
        color: var(--zw-text-2);
      }
      .message.error {
        color: var(--zw-danger);
      }
      .brand {
        font-size: 15px;
        font-weight: 600;
        color: var(--zw-text);
      }
      button {
        cursor: pointer;
        border: 0;
        background: none;
        padding: 0;
      }
      button:focus-visible,
      select:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border-radius: 14px;
        background: var(--zw-surface);
        font-size: 12px;
        font-weight: 500;
      }
      .chip.ok {
        background: color-mix(in srgb, var(--zw-ok) 14%, transparent);
        /* darker in light themes for contrast */
        color: color-mix(in srgb, var(--zw-ok) 70%, var(--zw-text));
      }
      .chip .dot {
        width: 7px;
        height: 7px;
        border-radius: 4px;
        background: var(--zw-ok);
      }
      .separator {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 24px;
        margin-top: 4px;
        font-size: 15px;
        font-weight: 600;
      }
      .separator .line {
        flex: 1;
        height: 1px;
        background: var(--zw-border);
      }
      /* Profile sliders */
      .sliders {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .slider {
        position: relative;
        height: 48px;
        border-radius: 24px;
        background: var(--zw-surface);
        overflow: hidden;
      }
      .fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        border-right: 2px solid;
        box-sizing: border-box;
        pointer-events: none;
      }
      .slider-content {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        height: 48px;
        padding: 0 16px 0 6px;
        pointer-events: none;
      }
      .picon {
        width: 36px;
        height: 36px;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .picon ha-icon {
        --mdc-icon-size: 18px;
      }
      .pname {
        flex: 1;
        font-size: 14px;
        font-weight: 600;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pname .muted {
        font-weight: 400;
        color: var(--zw-text-2);
      }
      .pvalue {
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .slider .hit,
      .slider .overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        touch-action: pan-y;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      .slider.armed {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      .slider:has(.hit:focus-visible) {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .swatch {
        width: 12px;
        height: 12px;
        border-radius: 4px;
      }
      .tl-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        padding: 4px 4px 0;
      }
      .tl-titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .tl-date {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .tl-title {
        font-size: 22px;
        font-weight: 700;
      }
      .tl-clock {
        font-size: 28px;
        font-weight: 600;
        letter-spacing: -0.5px;
        font-variant-numeric: tabular-nums;
      }
      .tl-axis {
        margin: 4px 0 0;
        padding: 0 14px;
      }
      .tl-back {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 32px;
        margin: -4px 0 -2px -4px;
        padding: 0 8px 0 4px;
        border-radius: 16px;
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
      }
      .tl-back:hover {
        background: var(--zw-surface);
      }
      .textbtn {
        align-self: flex-start;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 4px;
        color: var(--zw-text);
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .link {
        text-decoration: none;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 56px;
        padding: 8px 14px 8px 10px;
        text-align: left;
        box-sizing: border-box;
        color: var(--zw-text);
      }
      .link.settings {
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        padding-block: 12px;
      }
      .link svg {
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .licon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        border-radius: 18px;
        background: var(--zw-surface-2);
        display: flex;
        align-items: center;
        justify-content: center;
        --mdc-icon-size: 18px;
      }
      .ltext {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .ltitle {
        font-size: 14px;
        font-weight: 600;
      }
      .notice {
        font-size: 13px;
        padding: 8px 12px;
        border-radius: 12px;
        background: var(--zw-surface);
      }
      .notice.undo {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 4px 4px 4px 14px;
      }
      .pchips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 13px;
        color: var(--zw-text-2);
      }
      .pchip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .undo-btn {
        min-height: 36px;
        padding: 0 14px;
        border-radius: 18px;
        background: var(--zw-surface-2);
        font-size: 13px;
        font-weight: 700;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-card": ZeitwerkCard;
  }
  interface Window {
    customCards?: Array<{
      type: string;
      name: string;
      description: string;
      preview?: boolean;
      documentationURL?: string;
    }>;
  }
}

defineElements([
  ["zeitwerk-plan-header", ZeitwerkPlanHeader],
  ["zeitwerk-week-grid", ZeitwerkWeekGrid],
  ["zeitwerk-timeline-plan", ZeitwerkTimelinePlan],
  ["zeitwerk-card-editor", ZeitwerkCardEditor],
  ["zeitwerk-card", ZeitwerkCard],
]);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "zeitwerk-card")) {
  window.customCards.push({
    type: "zeitwerk-card",
    name: "Zeitwerk",
    description: "Weekly schedules with profiles and overrides",
    preview: true,
    documentationURL: "https://github.com/StiviDrum/zeitwerk",
  });
}

console.info(`%c ZEITWERK-CARD %c ${CARD_VERSION} `, "background:#ff8b4a;color:#1b0f07", "");
