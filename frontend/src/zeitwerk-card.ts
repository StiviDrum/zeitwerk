import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ZeitwerkDayEditor, type DaySaveDetail } from "./day-editor";
import { applyDayPlan, weekToDays, type DayKey } from "./day-plan";
import { ZeitwerkRules } from "./rules-page";
import { ZeitwerkProfiles } from "./profiles-page";
import { ZeitwerkPlanWizard } from "./plan-wizard";
import { ZeitwerkCardEditor } from "./card-editor";
import { ZeitwerkConditionsEditor } from "./conditions-editor";
import { defineElements } from "./register";
import type { PlanMutator } from "./rules-page";
import { conditionsSummary, pauseReason, type Condition } from "./conditions";
import { dayTypeFor, previousWeekday, rowSegments, type Segment } from "./blocks";
import { profileColor, textOn, tint } from "./colors";
import { localizer, type Localizer } from "./localize";
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
import { canvasMeasure, fitLabel, observeWidth, type TextMeasure } from "./labels";
import { tokens } from "./styles";
import { MINUTES_PER_DAY, formatTime, minutesFromToday, zonedClock, zonedNow } from "./time";
import {
  WEEKDAYS,
  type Block,
  type DayType,
  type HomeAssistant,
  type Plan,
  type PlanEvent,
  type Profile,
  type ZeitwerkCardConfig,
} from "./types";
import { CARD_VERSION } from "./version";

const VALUE_DEBOUNCE_MS = 400;
const SLIDER_HOLD_MS = 350;
const NOTICE_MS = 4000;
const UNDO_MS = 10_000;

interface QuickRow {
  profile: Profile;
  qv: QuickValue;
  control: Control;
}

interface GridRow {
  key: DayKey;
  label: string;
  dayType: DayType | undefined;
  segments: Segment[];
  active: boolean;
  today: boolean;
  /** 0 = today's row, 1 = tomorrow's row (manual override hatch). */
  dayOffset: number | null;
}

/** Copy of a plan without its runtime status (what plans/update takes). */
function stripStatus(plan: Plan): Plan {
  const copy = structuredClone(plan);
  delete copy.status;
  return copy;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

export class ZeitwerkCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: ZeitwerkCardConfig;
  @state() private _plan?: Plan | null;
  @state() private _error?: string;
  /** Day open in the day editor and its blocks when it was opened. */
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
  @state() private _editDay?: { day: DayKey; blocks: Block[] };
  @state() private _saveError: string | null = null;
  @state() private _busy = false;
  @state() private _notice?: string;
  /** Slider values not yet confirmed by the backend, per profile id. */
  @state() private _pending: Record<string, number | string> = {};
  @state() private _page: "week" | "rules" | "wizard" | "profiles" = "week";
  /** Last change made in this card, offered for undo for a few seconds. */
  @state() private _undo?: { before: Plan; after: string };
  private _undoTimer?: number;
  /** Plan before the current series of slider changes (one undo step). */
  private _sliderBefore?: Plan;
  private _sliderUndo?: { before: Plan; profileId: string; value: number | string };
  /** Timeline view: all (tag-filtered) plans and today's scheduled segments. */
  @state() private _plans?: Plan[];
  @state() private _segments: Record<string, { start: string; end: string; profile: string }[]> =
    {};
  private _previewTimer?: number;
  /** Width of a week-grid track in px (staged block labels). */
  @state() private _trackPx = 0;
  private _trackObs?: { el: Element; stop: () => void };
  private _measure?: TextMeasure;

  private _unsub?: Promise<() => Promise<void> | void>;
  private _subscribedPlan?: string;
  private _clock?: number;
  private _nowWeekday?: number;
  private _valueTimers: Record<string, number> = {};
  private _noticeTimer?: number;

  // --- Lovelace API ---------------------------------------------------------

  public setConfig(config: ZeitwerkCardConfig): void {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    if (config.time_step !== undefined && !(config.time_step >= 1 && config.time_step <= 60)) {
      throw new Error("time_step must be between 1 and 60 minutes");
    }
    this._config = { view: "week", show_profile_sliders: true, time_step: 15, ...config };
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
    this._startClock();
    if (this.hass && this._config) this._resubscribe();
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe();
    window.clearTimeout(this._clock);
    window.clearInterval(this._clock);
    this._clock = undefined;
    window.clearTimeout(this._previewTimer);
    this._sliderEnd();
    this._trackObs?.stop();
    this._trackObs = undefined;
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
      old.themes?.darkMode !== this.hass.themes?.darkMode
    ) {
      return true;
    }
    return this._watchedEntities().some((id) => old.states[id] !== this.hass!.states[id]);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass) {
      this.toggleAttribute("dark", !!this.hass.themes?.darkMode);
      if (!this._unsub && this._subscribedPlan === undefined && this._config && this.isConnected) {
        this._resubscribe();
      }
    }
  }

  protected updated(): void {
    this._updateNow();
    const track = this.renderRoot.querySelector(".rows .track");
    if (track !== this._trackObs?.el) {
      this._trackObs?.stop();
      this._trackObs = track
        ? {
            el: track,
            stop: observeWidth(track, (w) => {
              if (Math.abs(w - this._trackPx) > 0.5) this._trackPx = w;
            }),
          }
        : undefined;
    }
  }

  /** Entities whose state changes are relevant for rendering (DESIGN.md §3). */
  private _watchedEntities(): string[] {
    if (this._config?.view === "timeline") {
      return (this._plans ?? []).flatMap((plan) =>
        plan.profiles.map((p) => quickValue(p)?.entityId).filter((x): x is string => !!x),
      );
    }
    if (!this._plan) return [];
    const ids = [`switch.zeitwerk_${this._plan.id}`];
    for (const p of this._plan.profiles) {
      const qv = quickValue(p);
      if (qv) ids.push(qv.entityId);
    }
    // Condition entities: summaries and the pause reason show their state.
    const conditions = [
      ...this._plan.activation.conditions,
      ...this._plan.overrides.flatMap((o) => o.conditions),
    ];
    for (const c of conditions) {
      const e = c.entity_id;
      if (typeof e === "string") ids.push(e);
      else if (Array.isArray(e)) ids.push(...e.filter((x): x is string => typeof x === "string"));
    }
    return ids;
  }

  // --- Data -----------------------------------------------------------------

  private _unsubscribe(): void {
    const unsub = this._unsub;
    this._unsub = undefined;
    this._subscribedPlan = undefined;
    unsub?.then((fn) => fn()).catch(() => undefined);
  }

  private _resubscribe(): void {
    this._unsubscribe();
    this._plan = undefined;
    this._plans = undefined;
    this._error = undefined;
    if (this._config?.view === "timeline") {
      this._subscribeAll();
      return;
    }
    const planId = this._config?.plan;
    if (!this.hass?.connection || !planId || this._config?.view !== "week" || !this.isConnected)
      return;
    this._subscribedPlan = planId;
    const unsub = this.hass.connection.subscribeMessage<PlanEvent>((msg) => this._onEvent(msg), {
      type: "zeitwerk/plans/subscribe",
      plan_id: planId,
    });
    this._unsub = unsub;
    unsub.catch((err: { code?: string; message?: string }) => {
      if (this._unsub !== unsub) return;
      this._unsub = undefined;
      if (err?.code === "not_found") this._plan = null;
      else this._error = errorMessage(err);
    });
  }

  private _subscribeAll(): void {
    if (!this.hass?.connection || !this.isConnected) return;
    this._subscribedPlan = "*";
    const unsub = this.hass.connection.subscribeMessage<PlanEvent>(
      (msg) => {
        let plans = this._plans ?? [];
        if (msg.event === "init") plans = msg.plans ?? [];
        else if (msg.event === "removed") plans = plans.filter((p) => p.id !== msg.plan_id);
        else if (msg.plan) {
          const plan = msg.plan;
          const i = plans.findIndex((p) => p.id === msg.plan_id);
          plans = i < 0 ? [...plans, plan] : plans.map((p, j) => (j === i ? plan : p));
        }
        this._plans = plans;
        this._schedulePreview(msg.event === "init" ? 0 : 1000);
      },
      { type: "zeitwerk/plans/subscribe" },
    );
    this._unsub = unsub;
    unsub.catch((err) => {
      if (this._unsub !== unsub) return;
      this._unsub = undefined;
      this._error = errorMessage(err);
    });
  }

  private _timelinePlans(): Plan[] {
    const tags = this._config?.tags ?? [];
    const plans = this._plans ?? [];
    return tags.length ? plans.filter((p) => p.tags.some((t) => tags.includes(t))) : plans;
  }

  /** Fetch today's scheduled segments (debounced; plan edits change them). */
  private _schedulePreview(delay: number): void {
    window.clearTimeout(this._previewTimer);
    this._previewTimer = window.setTimeout(() => {
      const ids = this._timelinePlans().map((p) => p.id);
      if (!this.hass || !ids.length) return;
      this.hass
        .callWS<{ plans: Record<string, { start: string; end: string; profile: string }[]> }>({
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

  private async _updatePlan(mutate: PlanMutator): Promise<void> {
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
    const qv = quickValue(this._profile(pending.profileId));
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

  private _removePlan = async (): Promise<void> => {
    if (!this.hass || !this._plan) return;
    await this.hass.callWS({ type: "zeitwerk/plans/delete", plan_id: this._plan.id });
    this._page = "week";
  };

  private _duplicate = async (name: string): Promise<void> => {
    if (!this.hass || !this._plan) return;
    const copy = await this.hass.callWS<Plan>({
      type: "zeitwerk/plans/duplicate",
      plan_id: this._plan.id,
      name,
    });
    this._notify(this._l.t("duplicated", { name: copy.name, id: copy.id }), 12_000);
  };

  private _notify(text: string, ms = NOTICE_MS): void {
    this._notice = text;
    window.clearTimeout(this._noticeTimer);
    this._noticeTimer = window.setTimeout(() => (this._notice = undefined), ms);
  }

  // --- Now line -------------------------------------------------------------

  private _startClock(): void {
    if (this._clock !== undefined) return;
    const msToMinute = 60_000 - (Date.now() % 60_000) + 50;
    this._clock = window.setTimeout(() => {
      this._updateNow();
      this._clock = window.setInterval(() => this._updateNow(), 60_000);
    }, msToMinute);
  }

  /** Update only the CSS variable and the clock – no full re-render. */
  private _updateNow(): void {
    const now = zonedNow(this.hass?.config?.time_zone);
    this.style.setProperty("--zw-now", String(now.minutes / MINUTES_PER_DAY));
    if (this._nowWeekday !== undefined && this._nowWeekday !== now.weekdayIndex) {
      this.requestUpdate();
      if (this._config?.view === "timeline") this._schedulePreview(0);
    }
    const clock = this.renderRoot.querySelector<HTMLElement>(".tl-clock");
    if (clock) clock.textContent = formatTime(now.minutes);
    this._nowWeekday = now.weekdayIndex;
  }

  // --- Helpers --------------------------------------------------------------

  private get _l(): Localizer {
    return localizer(this.hass?.locale?.language ?? this.hass?.language);
  }

  private get _step(): number {
    return this._config?.time_step ?? 15;
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

  private _valueLabel(profile: Profile | undefined): string {
    if (!profile) return "";
    const q = this._quick(profile);
    if (!q) return "";
    const l = this._l;
    return formatValue(q.qv, q.control, l.lang, [l.t("on"), l.t("off")]);
  }

  private _profile(id: string | null | undefined): Profile | undefined {
    return this._plan?.profiles.find((p) => p.id === id);
  }

  // --- Actions --------------------------------------------------------------

  private _dayName(day: DayKey): string {
    return day === "holiday" ? this._l.t("holiday") : this._l.weekdayLong(WEEKDAYS.indexOf(day));
  }

  private _openDay(day: DayKey): void {
    if (!this._plan) return;
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    this._saveError = null;
    this._busy = false;
    this._editDay = { day, blocks: weekToDays(this._plan)[day] };
  }

  private _onSaveDay = async (ev: CustomEvent<DaySaveDetail>): Promise<void> => {
    const { blocks, targets } = ev.detail;
    const l = this._l;
    this._busy = true;
    this._saveError = null;
    try {
      await this._updatePlan((plan) => applyDayPlan(plan, targets, blocks, l));
      this._editDay = undefined;
    } catch (err) {
      this._saveError = l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  };

  private _togglePlan(): void {
    if (!this.hass || !this._plan) return;
    const on = !this._plan.enabled;
    this.hass
      .callService("switch", on ? "turn_on" : "turn_off", undefined, {
        entity_id: `switch.zeitwerk_${this._plan.id}`,
      })
      .catch((err) => this._notify(errorMessage(err)));
  }

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

  // --- Drag block edges -------------------------------------------------------

  // --- Rendering ------------------------------------------------------------

  protected render() {
    if (!this._config) return nothing;
    const l = this._l;
    if (this._page === "wizard" && this.hass) {
      const missing =
        this._config.view !== "timeline" && this._plan === null ? this._config.plan : undefined;
      return html`<ha-card>
        <zeitwerk-plan-wizard
          ?dark=${!!this.hass.themes?.darkMode}
          .hass=${this.hass}
          .localize=${l}
          .presetId=${missing}
          @zw-cancel=${() => (this._page = "week")}
          @zw-created=${this._onCreated}
        ></zeitwerk-plan-wizard>
      </ha-card>`;
    }
    if (this._config.view === "timeline") {
      if (this._error) return this._message(l.t("not_loaded", { error: this._error }), true);
      if (!this.hass || this._plans === undefined) return this._message(l.t("loading"));
      return this._renderTimeline();
    }
    if (this._config.view && this._config.view !== "week") {
      return this._message(l.t("view_unsupported", { view: this._config.view }));
    }
    if (!this._config.plan) return this._message(l.t("no_plan"), false, true);
    if (this._error) return this._message(l.t("not_loaded", { error: this._error }), true);
    if (!this.hass || this._plan === undefined) return this._message(l.t("loading"));
    if (this._plan === null)
      return this._message(l.t("plan_missing", { plan: this._config.plan }), true, true);
    return this._renderWeek(this._plan);
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
      ? plans.map((p) => this._renderTimelinePlan(p))
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
    </ha-card>`;
  }

  private _renderTimelinePlan(plan: Plan) {
    const l = this._l;
    const tz = this.hass?.config?.time_zone;
    const status = plan.status;
    const current = plan.profiles.find((p) => p.id === status?.profile);
    const color = current ? profileColor(plan, current) : "var(--zw-text-2)";
    const isDefault = !current || current.id === plan.default_profile;
    const def = profileColor(plan, plan.default_profile);
    let sub: string;
    if (!plan.enabled) sub = l.t("plan_off");
    else if (status && !status.active && !current) sub = l.t("plan_paused");
    else if (status?.manual_since) {
      const entity = status.manual_entity ? this.hass?.states[status.manual_entity] : undefined;
      const value = entity ? (this.hass?.formatEntityState?.(entity) ?? entity.state) : "";
      sub = value ? `${l.t("manual_cap")} · ${value}` : l.t("manual_cap");
    } else {
      const value = current ? this._valueLabel(current) : "";
      sub = current ? (value ? `${current.name} · ${value}` : current.name) : "";
    }
    let whenText = "";
    if (status?.manual_since && status.manual_until) {
      whenText = l.t("until_time", { time: zonedClock(status.manual_until, tz) });
    } else if (status?.next_change) {
      const mins = Math.round((new Date(status.next_change).getTime() - Date.now()) / 60_000);
      whenText =
        mins >= 0 && mins < 60
          ? l.t("in_minutes", { n: Math.max(1, mins) })
          : l.t("from_time", { time: zonedClock(status.next_change, tz) });
    }
    const next = status?.next_change
      ? plan.profiles.find((p) => p.id === status.next_profile)
      : undefined;
    const nextValue = next ? this._valueLabel(next) || next.name : "";
    const nextColor = next && next.id !== plan.default_profile ? profileColor(plan, next) : "";
    const segs = (this._segments[plan.id] ?? [])
      .map((seg) => ({
        from: Math.max(0, minutesFromToday(seg.start, tz)),
        to: Math.min(MINUTES_PER_DAY, minutesFromToday(seg.end, tz)),
        profile: seg.profile,
      }))
      .filter((seg) => seg.to > seg.from && seg.profile !== plan.default_profile);
    const manual = this._manualSegment(plan, 0);
    const pct = (m: number) => (m / MINUTES_PER_DAY) * 100;
    return html`<div
      class="tl-plan"
      style=${!isDefault && plan.enabled ? `border-color:${tint(color, 45)}` : ""}
    >
      <div class="tl-row">
        <span class="tl-icon" style="background:${tint(color, 18)};color:${color}">
          <ha-icon .icon=${current?.icon || plan.icon || "mdi:calendar-clock"}></ha-icon>
        </span>
        <span class="tl-text">
          <span class="tl-name">${plan.name}</span>
          <span class="tl-sub" style=${isDefault ? "" : `color:${color}`}>${sub}</span>
        </span>
        ${
          whenText
            ? html`<span class="tl-next">
                <span class="tl-when">${whenText}</span>
                <span class="tl-value" style=${nextColor ? `color:${nextColor}` : ""}
                  >${nextValue}</span
                >
              </span>`
            : nothing
        }
      </div>
      <div class="band" style="background:${tint(def, 16)}">
        ${segs.map(
          (seg) =>
            html`<span
              class="band-seg"
              style="left:${pct(seg.from)}%;width:${pct(seg.to - seg.from)}%;background:${profileColor(
                plan,
                seg.profile,
              )}"
            ></span>`,
        )}
        ${
          manual
            ? html`<span
                class="band-seg hatch"
                style="left:${manual.left}%;width:${manual.width}%"
              ></span>`
            : nothing
        }
        <span class="band-now" aria-hidden="true"></span>
      </div>
    </div>`;
  }

  private _onCreated = (ev: CustomEvent<{ id: string; name: string }>): void => {
    this._page = "week";
    const { id, name } = ev.detail;
    if (this._config?.view !== "timeline") {
      if (this._config?.plan === id) this._resubscribe();
      else this._notify(this._l.t("created", { name, id }));
    }
  };

  private _newPlanButton() {
    if (!this.hass?.user?.is_admin) return nothing;
    return html`<button class="textbtn" @click=${() => (this._page = "wizard")}>
      ${this._l.t("new_plan")}
    </button>`;
  }

  private _message(text: string, isError = false, offerWizard = false) {
    return html`<ha-card>
      <div class="message ${isError ? "error" : ""}" role=${isError ? "alert" : nothing}>
        <span class="brand">Zeitwerk</span>
        <span>${text}</span>
        ${this._notice ? html`<span class="notice">${this._notice}</span>` : nothing}
        ${offerWizard ? this._newPlanButton() : nothing}
      </div>
    </ha-card>`;
  }

  private _renderWeek(plan: Plan) {
    const quick =
      this._config!.show_profile_sliders && !this._config!.compact
        ? plan.profiles.map((p) => this._quick(p)).filter((q): q is QuickRow => !!q)
        : [];
    const l = this._l;
    if (this._editDay) {
      const labels: Record<string, string> = {};
      for (const p of plan.profiles) labels[p.id] = this._valueLabel(p);
      return html`<ha-card>
        <zeitwerk-day-editor
          ?dark=${!!this.hass?.themes?.darkMode}
          .plan=${plan}
          .day=${this._editDay.day}
          .initial=${this._editDay.blocks}
          .localize=${l}
          .valueLabels=${labels}
          .withHoliday=${plan.holidays.mode === "own_day_type" && !!plan.holidays.day_type}
          .step=${this._step}
          .error=${this._saveError}
          .busy=${this._busy}
          @zw-close=${() => (this._editDay = undefined)}
          @zw-save-day=${this._onSaveDay}
        ></zeitwerk-day-editor>
      </ha-card>`;
    }
    if (this._page === "rules") {
      return html`<ha-card>
        <zeitwerk-rules
          ?dark=${!!this.hass?.themes?.darkMode}
          .hass=${this.hass}
          .plan=${plan}
          .localize=${l}
          .save=${(m: PlanMutator) => this._updatePlan(m)}
          .duplicate=${this._duplicate}
          .deletePlan=${this._removePlan}
          @zw-back=${() => (this._page = "week")}
        ></zeitwerk-rules>
        ${this._renderUndo()}
        ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
      </ha-card>`;
    }
    if (this._page === "profiles") {
      return html`<ha-card>
        <zeitwerk-profiles
          ?dark=${!!this.hass?.themes?.darkMode}
          .hass=${this.hass}
          .plan=${plan}
          .localize=${l}
          .save=${(m: PlanMutator) => this._updatePlan(m)}
          @zw-back=${() => (this._page = "week")}
        ></zeitwerk-profiles>
      </ha-card>`;
    }
    return html`<ha-card class=${this._config!.compact ? "compact" : ""}>
      ${this._renderHeader(plan)}
      ${this._config!.compact ? nothing : this._separator(l.t("section_profiles"), this._openProfiles)}
      ${
        this._config!.compact
          ? nothing
          : quick.length
            ? html`<div class="sliders">${quick.map((q) => this._renderSlider(plan, q))}</div>`
            : html`<div class="pchips">
                ${plan.profiles.map(
                  (p) =>
                    html`<span class="pchip"
                      ><span class="swatch" style="background:${profileColor(plan, p)}"></span
                      >${p.name}</span
                    >`,
                )}
              </div>`
      }
      ${this._separator(l.t("section_week"))} ${this._renderGrid(plan)}
      ${this._config!.compact ? nothing : this._renderRulesLinks(plan)} ${this._renderUndo()}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
    </ha-card>`;
  }

  private _separator(title: string, gear?: () => void) {
    return html`<div class="separator">
      <span>${title}</span><span class="line"></span>${
        gear
          ? html`<button
              class="gear"
              aria-label=${this._l.t("edit_profiles")}
              title=${this._l.t("edit_profiles")}
              @click=${gear}
            >
              <ha-icon .icon=${"mdi:cog-outline"}></ha-icon>
            </button>`
          : nothing
      }
    </div>`;
  }

  private _openProfiles = (): void => {
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    this._page = "profiles";
  };

  private _renderHeader(plan: Plan) {
    const l = this._l;
    const status = plan.status;
    const current = this._profile(status?.profile);
    const color = current ? profileColor(plan, current) : "var(--zw-text-2)";
    let subline: TemplateResult | string = "";
    if (status?.error) {
      subline = html`<span class="danger">${l.t("plan_error")}: ${status.error}</span>`;
    } else if (!plan.enabled) {
      subline = l.t("plan_off");
    } else if (current) {
      const value = this._valueLabel(current);
      const next = this._profile(status?.next_profile);
      const tz = this.hass?.config?.time_zone;
      const nextText =
        status?.next_change && next
          ? ` · ${l.t("from_time", { time: zonedClock(status.next_change, tz) })} → ${this._valueLabel(next) || next.name}`
          : "";
      subline = html`<span class="current" style="color:${color}"
          >${current.name}${value ? ` ${value}` : ""}</span
        >${nextText}`;
    } else if (status?.source === "inactive") {
      subline = this._pausedText(plan);
    }
    if (status?.source === "inactive" && current) {
      subline = html`${subline} · ${this._pausedText(plan)}`;
    }
    return html`<div class="header">
      <div class="icon" style="background:${tint(color, 18)};color:${color}">
        <ha-icon .icon=${plan.icon || "mdi:calendar-clock"}></ha-icon>
      </div>
      <div class="titles">
        <div class="name">${plan.name}</div>
        <div class="sub">${subline}</div>
        ${this._renderReason(plan)}
      </div>
      <button
        class="switch"
        role="switch"
        aria-label=${l.t("toggle_plan")}
        aria-checked=${plan.enabled ? "true" : "false"}
        @click=${this._togglePlan}
      >
        <span></span>
      </button>
    </div>`;
  }

  /**
   * Why the plan deviates from the week plan right now (override, forced
   * profile, manual change, holiday) – one quiet line in the header, shown
   * only when something applies.
   */
  private _renderReason(plan: Plan) {
    const l = this._l;
    const status = plan.status;
    if (!status || !plan.enabled || status.error || !status.active) return nothing;
    const tz = this.hass?.config?.time_zone;
    const items: { icon: string; text: string; color?: string }[] = [];
    const source = status.source ?? "";
    if (status.manual_since) {
      items.push({
        icon: "mdi:hand-back-right-outline",
        text: status.manual_until
          ? l.t("manual_until", { time: zonedClock(status.manual_until, tz) })
          : l.t("manual"),
      });
    } else if (status.forced_until) {
      const forced = this._profile(status.profile);
      items.push({
        icon: "mdi:timer-outline",
        text: l.t("forced_until", {
          profile: forced?.name ?? "",
          time: zonedClock(status.forced_until, tz),
        }),
        color: forced ? profileColor(plan, forced) : undefined,
      });
    } else if (source.startsWith("override:")) {
      const ov = plan.overrides.find((o) => o.id === source.slice(9));
      const profile = this._profile(ov?.profile ?? status.profile);
      items.push({
        icon: "mdi:layers-outline",
        text: l.t("override_reason", { name: ov?.name ?? source.slice(9) }),
        color: profile ? profileColor(plan, profile) : undefined,
      });
    }
    if (status.is_holiday) items.push({ icon: "mdi:flag-outline", text: l.t("holiday") });
    if (!items.length) return nothing;
    return html`<div class="reason">
      ${items.map(
        (item) =>
          html`<span class="ritem" style=${item.color ? `color:${item.color}` : ""}
            ><ha-icon .icon=${item.icon}></ha-icon>${item.text}</span
          >`,
      )}
    </div>`;
  }

  private _pausedText(plan: Plan): string {
    const l = this._l;
    const reason = pauseReason(
      plan.activation.conditions as Condition[],
      plan.status?.activation_results ?? [],
      this.hass,
      l,
    );
    return reason ? l.t("paused_reason", { reason }) : l.t("plan_paused");
  }

  private _renderRulesLinks(plan: Plan) {
    const l = this._l;
    const results = plan.status?.override_results ?? {};
    const active = plan.overrides.filter((o) => results[o.id]);
    const overrides = plan.overrides.length
      ? `${plan.overrides.map((o) => o.name).join(", ")} · ${
          active.length
            ? active.map((o) => l.t("override_active", { name: o.name })).join(", ")
            : l.t("none_active")
        }`
      : l.t("no_conditions");
    const act = plan.activation;
    const activation = act.conditions.length
      ? `${conditionsSummary(act.conditions as Condition[], act.match, this.hass, l)} · ${
          plan.status?.active ? l.t("fulfilled") : l.t("not_fulfilled")
        }`
      : l.t("always_runs");
    const holidays = this._holidaySummary(plan);
    const summary = [
      `${l.t("rules_overrides")}: ${overrides}`,
      `${l.t("rules_activation")}: ${activation}`,
      `${l.t("rules_holidays")}: ${holidays}`,
    ];
    return html`<button class="link settings" @click=${() => (this._page = "rules")}>
      <span class="licon"><ha-icon .icon=${"mdi:tune-variant"}></ha-icon></span>
      <span class="ltext">
        <span class="ltitle">${l.t("config_title")}</span>
        ${summary.map((line) => html`<span class="lsub">${line}</span>`)}
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
    </button>`;
  }

  private _holidaySummary(plan: Plan): string {
    const l = this._l;
    const h = plan.holidays;
    if (h.mode === "off" || !h.source) return l.t("holiday_mode_off");
    const source = String(this.hass?.states[h.source]?.attributes.friendly_name ?? h.source);
    if (h.mode === "like_day") {
      return l.t("holiday_summary_like", {
        source,
        day: l.weekdayLong(WEEKDAYS.indexOf(h.like_day ?? "sun")),
      });
    }
    return l.t("holiday_summary_own", { source });
  }

  /** Hatched range of a manual override within one row (today/tomorrow). */
  private _manualSegment(plan: Plan, dayOffset: number): { left: number; width: number } | null {
    const status = plan.status;
    if (!status?.manual_since) return null;
    const tz = this.hass?.config?.time_zone;
    const dayStart = (iso: string | null | undefined, fallback: number) =>
      iso ? minutesFromToday(iso, tz) : fallback;
    const from = Math.max(dayStart(status.manual_since, 0), dayOffset * MINUTES_PER_DAY);
    const to = Math.min(
      dayStart(status.manual_until, (dayOffset + 1) * MINUTES_PER_DAY),
      (dayOffset + 1) * MINUTES_PER_DAY,
    );
    if (to <= from) return null;
    const base = dayOffset * MINUTES_PER_DAY;
    return {
      left: ((from - base) / MINUTES_PER_DAY) * 100,
      width: ((to - from) / MINUTES_PER_DAY) * 100,
    };
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

  private _rows(plan: Plan): GridRow[] {
    const l = this._l;
    const now = zonedNow(this.hass?.config?.time_zone);
    const rows: GridRow[] = WEEKDAYS.map((wd, i) => {
      const dayType = dayTypeFor(plan, wd);
      const active = true;
      return {
        key: wd,
        label: l.weekdayShort(i),
        dayType,
        segments: rowSegments(dayType, dayTypeFor(plan, previousWeekday(wd))),
        active,
        today: i === now.weekdayIndex && !plan.status?.is_holiday,
        dayOffset: (i - now.weekdayIndex + 7) % 7 <= 1 ? (i - now.weekdayIndex + 7) % 7 : null,
      };
    });
    if (plan.holidays.mode === "own_day_type") {
      const holiday = plan.week.day_types.find((d) => d.id === plan.holidays.day_type);
      if (holiday) {
        rows.push({
          key: "holiday",
          label: l.t("holiday_short"),
          dayType: holiday,
          segments: rowSegments(holiday, undefined),
          active: true,
          today: !!plan.status?.is_holiday,
          dayOffset: null,
        });
      }
    }
    return rows;
  }

  private _renderGrid(plan: Plan) {
    const l = this._l;
    const def = profileColor(plan, plan.default_profile);
    const rows = this._rows(plan);
    const measure = (this._measure ??= canvasMeasure(
      `700 11px ${getComputedStyle(this).fontFamily || "sans-serif"}`,
    ));
    const used = new Set(plan.week.day_types.flatMap((d) => d.blocks.map((b) => b.profile)));
    const legend = plan.profiles.filter((p) => used.has(p.id) && p.id !== plan.default_profile);
    const defaultProfile = this._profile(plan.default_profile);

    return html`<div class="grid">
      <div class="axis grid-axis">
        ${[0, 6, 12, 18, 24].map((h) => html`<span style="left:${(h / 24) * 100}%">${h}</span>`)}
      </div>
      <div class="rows">
        ${rows.map(
          (row) =>
            html`<button
              class="row ${row.today ? "today" : ""}"
              aria-label=${l.t("day_editor_title", { day: this._dayName(row.key) })}
              @click=${() => this._openDay(row.key)}
            >
              <span class="day ${row.today ? "today" : ""}">${row.label}</span>
              <span class="track" style="background:${tint(def, 16)}">
                ${row.segments.map((seg) => {
                  const color = profileColor(plan, seg.profile);
                  const px = (seg.width / 100) * this._trackPx;
                  return html`<span
                    class="block ${seg.spill ? "spill" : ""}"
                    title="${seg.label} · ${this._profile(seg.profile)?.name ?? seg.profile}"
                    style="left:${seg.left}%;width:${seg.width}%;background:${color};color:${textOn(color)}"
                    ><span class="blabel"
                      >${fitLabel([seg.label, seg.short], px, measure)}</span
                    ></span
                  >`;
                })}
                ${this._renderManual(plan, row)}
              </span>
            </button>`,
        )}
        ${[0.25, 0.5, 0.75].map(
          (f) => html`<div class="hour-line" style="--zw-at:${f}" aria-hidden="true"></div>`,
        )}
        <div class="now-line" aria-hidden="true"></div>
        <div class="now-dot" aria-hidden="true"></div>
      </div>
      ${
        this._config!.compact
          ? nothing
          : html`<div class="legend">
                ${legend.map(
                  (p) =>
                    html`<span
                      ><span class="swatch" style="background:${profileColor(plan, p)}"></span
                      >${p.name}</span
                    >`,
                )}
                ${
                  defaultProfile
                    ? html`<span
                        ><span class="swatch" style="background:${tint(def, 45)}"></span
                        >${defaultProfile.name} (${l.t("default_suffix")})</span
                      >`
                    : nothing
                }
              </div>
              <div class="hint">${l.t("tap_day_hint")}</div>`
      }
    </div>`;
  }

  private _renderManual(plan: Plan, row: GridRow) {
    if (row.dayOffset === null) return nothing;
    // On a holiday the hatch belongs to the holiday row, not the weekday row.
    if (plan.status?.is_holiday && plan.holidays.mode === "own_day_type") return nothing;
    const seg = this._manualSegment(plan, row.dayOffset);
    if (!seg) return nothing;
    return html`<div
      class="hatch"
      style="left:${seg.left}%;width:${seg.width}%"
      title=${this._l.t("manual")}
    ></div>`;
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
        --zw-track: 30px;
      }
      ha-card.compact {
        --zw-track: 22px;
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
      input:focus-visible + *,
      select:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }

      /* Header */
      .header {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 64px;
        padding: 9px 10px;
        border-radius: 32px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        box-sizing: border-box;
      }
      .icon {
        width: 44px;
        height: 44px;
        border-radius: 22px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .icon ha-icon {
        --mdc-icon-size: 22px;
      }
      .titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }
      .name {
        font-size: 15px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        font-size: 13px;
        color: var(--zw-text-2);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .reason {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 12px;
        margin-top: 2px;
        font-size: 12px;
        font-weight: 600;
        color: var(--zw-text-2);
      }
      .ritem {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .ritem ha-icon {
        --mdc-icon-size: 14px;
      }
      .current {
        font-weight: 600;
      }
      .danger {
        color: var(--zw-danger);
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
      .switch::before {
        content: "";
        position: absolute;
        inset: -6px;
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

      /* Chips */
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
      .chip ha-icon {
        --mdc-icon-size: 14px;
      }
      .chip.muted {
        color: var(--zw-text-2);
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

      /* Day type tabs */

      /* Week grid */
      .grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 2px 2px 0;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        margin-left: 30px;
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .grid-axis {
        position: relative;
        display: block;
        height: 14px;
      }
      .grid-axis span {
        position: absolute;
        transform: translateX(-50%);
      }
      .grid-axis span:first-child {
        transform: none;
      }
      .grid-axis span:last-child {
        transform: translateX(-100%);
      }
      .rows {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        border-radius: 10px;
        -webkit-tap-highlight-color: transparent;
      }
      .row:hover .track {
        outline: 1px solid color-mix(in srgb, var(--zw-text) 25%, transparent);
      }
      .row.today .track {
        outline: 1.5px solid color-mix(in srgb, var(--zw-text) 60%, transparent);
        outline-offset: 1px;
      }
      .day {
        width: 26px;
        flex-shrink: 0;
        font-size: 13px;
        font-weight: 500;
        color: var(--zw-text-2);
      }
      .day.today {
        font-weight: 700;
        color: var(--zw-text);
      }
      .track {
        position: relative;
        flex: 1;
        height: var(--zw-track);
        border-radius: 10px;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }
      .block {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        white-space: nowrap;
      }
      .block.spill {
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
      }
      .block span {
        pointer-events: none;
      }
      .blabel {
        max-width: 100%;
        overflow: hidden;
        white-space: nowrap;
      }
      .hour-line {
        position: absolute;
        top: -4px;
        bottom: -4px;
        left: calc(30px + (100% - 30px) * var(--zw-at));
        border-left: 1px dashed color-mix(in srgb, var(--zw-text) 35%, transparent);
        pointer-events: none;
      }
      .now-line {
        position: absolute;
        top: -6px;
        bottom: -6px;
        left: calc(30px + (100% - 30px) * var(--zw-now, 0));
        width: 2px;
        border-radius: 1px;
        background: var(--zw-text);
        pointer-events: none;
      }
      .now-dot {
        position: absolute;
        top: -10px;
        left: calc(30px + (100% - 30px) * var(--zw-now, 0) - 4px);
        width: 10px;
        height: 10px;
        border-radius: 5px;
        background: var(--zw-text);
        pointer-events: none;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .legend > span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .swatch {
        width: 12px;
        height: 12px;
        border-radius: 4px;
      }
      .hint {
        font-size: 12px;
        color: var(--zw-text-2);
        padding: 0 4px;
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
      .tl-plan {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px 14px;
        border-radius: 26px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
      }
      .tl-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .tl-icon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        --mdc-icon-size: 18px;
      }
      .tl-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .tl-name {
        font-size: 14px;
        font-weight: 600;
      }
      .tl-sub {
        font-size: 12px;
        color: var(--zw-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tl-next {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        flex-shrink: 0;
      }
      .tl-when {
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .tl-value {
        font-size: 13px;
        font-weight: 600;
      }
      .band {
        position: relative;
        height: 16px;
        border-radius: 8px;
      }
      .band-seg {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 8px;
      }
      .band-now {
        position: absolute;
        top: -4px;
        bottom: -4px;
        left: calc(100% * var(--zw-now, 0));
        width: 2px;
        border-radius: 1px;
        background: var(--zw-text);
      }
      .block {
        overflow: visible;
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
      .copy {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border-radius: 18px;
        background: var(--zw-surface);
      }
      .hatch {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 10px;
        pointer-events: none;
        background: repeating-linear-gradient(
          135deg,
          color-mix(in srgb, var(--zw-text) 55%, transparent) 0 2px,
          transparent 2px 7px
        );
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--zw-text) 40%, transparent);
      }
      .link {
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
      .link + .link {
        border-top: 1px solid var(--zw-border);
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
      .lsub {
        font-size: 12px;
        color: var(--zw-text-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      .gear {
        width: 32px;
        height: 32px;
        margin-right: -6px;
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--zw-text-2);
      }
      .gear:hover {
        background: var(--zw-surface);
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
  ["zeitwerk-day-editor", ZeitwerkDayEditor],
  ["zeitwerk-conditions-editor", ZeitwerkConditionsEditor],
  ["zeitwerk-rules", ZeitwerkRules],
  ["zeitwerk-profiles", ZeitwerkProfiles],
  ["zeitwerk-plan-wizard", ZeitwerkPlanWizard],
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
