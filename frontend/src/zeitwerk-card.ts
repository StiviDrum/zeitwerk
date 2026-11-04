import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./block-editor";
import "./rules-page";
import "./plan-wizard";
import "./card-editor";
import type { PlanMutator } from "./rules-page";
import { conditionsSummary, pauseReason, type Condition } from "./conditions";
import type { BlockEditTarget, BlockSaveDetail } from "./block-editor";
import {
  blockAt,
  copyDayType,
  dayTypeFor,
  dragBlock,
  toInterval,
  type Edge,
  freeUntil,
  insertBlock,
  previousWeekday,
  removeBlock,
  replaceBlock,
  rowSegments,
  type Segment,
} from "./blocks";
import { profileColor, textOn, tint } from "./colors";
import { daysLabel, localizer, type Localizer } from "./localize";
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
import { tokens } from "./styles";
import {
  MINUTES_PER_DAY,
  clamp,
  formatTime,
  minutesFromToday,
  snap,
  zonedClock,
  zonedNow,
} from "./time";
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

const LONG_PRESS_MS = 500;
const VALUE_DEBOUNCE_MS = 400;
const NOTICE_MS = 4000;
const HOLIDAY_LIKE_TAB = "__holiday_like";

interface QuickRow {
  profile: Profile;
  qv: QuickValue;
  control: Control;
}

interface GridRow {
  key: string;
  label: string;
  dayType: DayType | undefined;
  segments: Segment[];
  active: boolean;
  today: boolean;
  /** 0 = today's row, 1 = tomorrow's row (manual override hatch). */
  dayOffset: number | null;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

@customElement("zeitwerk-card")
export class ZeitwerkCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: ZeitwerkCardConfig;
  @state() private _plan?: Plan | null;
  @state() private _error?: string;
  @state() private _tab?: string;
  @state() private _editing?: BlockEditTarget;
  @state() private _saveError: string | null = null;
  @state() private _busy = false;
  @state() private _notice?: string;
  /** Slider values not yet confirmed by the backend, per profile id. */
  @state() private _pending: Record<string, number | string> = {};
  @state() private _page: "week" | "rules" | "wizard" = "week";
  /** Block being dragged / moved by keyboard, not yet saved. */
  @state() private _preview?: {
    dayTypeId: string;
    index: number;
    block: Block;
    rowKey?: string;
    edge?: Edge;
  };
  @state() private _copyOpen = false;
  /** Timeline view: all (tag-filtered) plans and today's scheduled segments. */
  @state() private _plans?: Plan[];
  @state() private _segments: Record<string, { start: string; end: string; profile: string }[]> =
    {};
  private _previewTimer?: number;
  @state() private _copyTargets: string[] = [];
  private _drag?: {
    dayTypeId: string;
    index: number;
    edge: Edge;
    original: Block;
    startX: number;
    width: number;
    moved: boolean;
  };
  private _suppressClick = false;
  private _keyTimer?: number;

  private _unsub?: Promise<() => Promise<void> | void>;
  private _subscribedPlan?: string;
  private _clock?: number;
  private _nowWeekday?: number;
  private _press?: { timer: number; x: number; y: number };
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
    this._cancelPress();
    this._stopDrag();
    window.clearTimeout(this._keyTimer);
    window.clearTimeout(this._previewTimer);
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
    }
  }

  private async _updatePlan(mutate: PlanMutator): Promise<void> {
    if (!this.hass || !this._plan) return;
    const plan = structuredClone(this._plan);
    delete plan.status;
    mutate(plan);
    await this.hass.callWS({ type: "zeitwerk/plans/update", plan_id: plan.id, plan });
  }

  private _notify(text: string): void {
    this._notice = text;
    window.clearTimeout(this._noticeTimer);
    this._noticeTimer = window.setTimeout(() => (this._notice = undefined), NOTICE_MS);
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

  /** Update only the CSS variable and the caption time – no full re-render. */
  private _updateNow(): void {
    const now = zonedNow(this.hass?.config?.time_zone);
    this.style.setProperty("--zw-now", String(now.minutes / MINUTES_PER_DAY));
    const caption = this.renderRoot.querySelector<HTMLElement>(".now-time");
    if (caption) caption.textContent = this._l.t("now", { time: formatTime(now.minutes) });
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

  private _dayTypeLabel(dt: DayType): string {
    const indices = dt.days.map((d) => WEEKDAYS.indexOf(d));
    return `${dt.name} (${daysLabel(indices, this._l)})`;
  }

  // --- Actions --------------------------------------------------------------

  private _togglePlan(): void {
    if (!this.hass || !this._plan) return;
    const on = !this._plan.enabled;
    this.hass
      .callService("switch", on ? "turn_on" : "turn_off", undefined, {
        entity_id: `switch.zeitwerk_${this._plan.id}`,
      })
      .catch((err) => this._notify(errorMessage(err)));
  }

  private _onSlider(row: QuickRow, ev: Event): void {
    if (row.control.type !== "number") return;
    const input = ev.target as HTMLInputElement;
    const { min, max, step } = row.control;
    const value = snapValue(Number(input.value), min, max, step);
    this._setValue(row, value);
  }

  private _setValue(row: QuickRow, value: number | string): void {
    if (!this.hass || !this._plan || row.qv.kind !== "value") return;
    const profileId = row.profile.id;
    this._pending = { ...this._pending, [profileId]: value };
    window.clearTimeout(this._valueTimers[profileId]);
    const planId = this._plan.id;
    const entityId = row.qv.entityId;
    this._valueTimers[profileId] = window.setTimeout(() => {
      delete this._valueTimers[profileId];
      this.hass
        ?.callService("zeitwerk", "set_profile_value", {
          plan: planId,
          profile: profileId,
          value,
          entity_id: entityId,
        })
        .catch((err) => {
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

  private _openEditor(target: BlockEditTarget): void {
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    this._saveError = null;
    this._busy = false;
    this._editing = target;
  }

  private _onBlockClick(seg: Segment): void {
    if (this._suppressClick) return;
    const dt = this._plan?.week.day_types.find((d) => d.id === seg.dayType);
    const block = dt?.blocks[seg.index];
    if (!dt || !block) return;
    this._openEditor({ dayTypeId: dt.id, index: seg.index, block: { ...block } });
  }

  private _onBlockKey(seg: Segment, ev: KeyboardEvent): void {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Delete" || ev.key === "Backspace") {
      // Delete opens the editor, where deleting is confirmed with the button.
      ev.preventDefault();
      this._onBlockClick(seg);
      return;
    }
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    const dt = this._plan?.week.day_types.find((d) => d.id === seg.dayType);
    const original = dt?.blocks[seg.index];
    if (!dt || !original) return;
    const current =
      this._preview?.dayTypeId === dt.id && this._preview.index === seg.index
        ? this._preview.block
        : original;
    const edge: Edge = ev.shiftKey ? "end" : ev.altKey ? "start" : "move";
    const delta = (ev.key === "ArrowLeft" ? -1 : 1) * this._step;
    this._preview = {
      dayTypeId: dt.id,
      index: seg.index,
      block: dragBlock(current, edge, delta, this._step),
    };
    window.clearTimeout(this._keyTimer);
    this._keyTimer = window.setTimeout(() => this._commitPreview(), 800);
  }

  // --- Drag block edges -------------------------------------------------------

  private _onEdgeDown(seg: Segment, edge: Edge, rowKey: string, ev: PointerEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.button !== 0) return;
    if (!this.hass?.user?.is_admin) {
      this._notify(this._l.t("admin_only"));
      return;
    }
    const dt = this._plan?.week.day_types.find((d) => d.id === seg.dayType);
    const original = dt?.blocks[seg.index];
    const track = (ev.currentTarget as HTMLElement).closest(".track");
    if (!dt || !original || !track) return;
    this._cancelPress();
    this._drag = {
      dayTypeId: dt.id,
      index: seg.index,
      edge,
      original,
      startX: ev.clientX,
      width: track.getBoundingClientRect().width,
      moved: false,
    };
    this._preview = { dayTypeId: dt.id, index: seg.index, block: original, rowKey, edge };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
    window.addEventListener("pointercancel", this._onDragCancel);
  }

  private _onDragMove = (ev: PointerEvent): void => {
    const drag = this._drag;
    if (!drag || !this._preview) return;
    const dx = ev.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    const delta = (dx / drag.width) * MINUTES_PER_DAY;
    this._preview = {
      ...this._preview,
      block: dragBlock(drag.original, drag.edge, delta, this._step),
    };
  };

  private _onDragEnd = (): void => {
    const drag = this._drag;
    this._stopDrag();
    if (!drag) return;
    if (drag.moved) {
      this._suppressClick = true;
      window.setTimeout(() => (this._suppressClick = false), 0);
      this._commitPreview();
    } else {
      this._preview = undefined;
    }
  };

  private _onDragCancel = (): void => {
    this._stopDrag();
    this._preview = undefined;
  };

  private _stopDrag(): void {
    this._drag = undefined;
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
    window.removeEventListener("pointercancel", this._onDragCancel);
  }

  private async _commitPreview(): Promise<void> {
    const preview = this._preview;
    if (!preview || !this._plan) return;
    const original = this._plan.week.day_types.find((d) => d.id === preview.dayTypeId)?.blocks[
      preview.index
    ];
    if (original && original.start === preview.block.start && original.end === preview.block.end) {
      this._preview = undefined;
      return;
    }
    const def = this._plan.default_profile;
    try {
      await this._updatePlan((plan) => {
        const dt = plan.week.day_types.find((d) => d.id === preview.dayTypeId);
        if (dt) dt.blocks = replaceBlock(dt.blocks, preview.index, preview.block, def);
      });
    } catch (err) {
      this._notify(this._l.t("save_failed", { error: errorMessage(err) }));
    } finally {
      if (this._preview === preview || this._preview?.block === preview.block)
        this._preview = undefined;
    }
  }

  /** Plan as shown: with the block being dragged replaced (not normalised yet). */
  private _shownPlan(plan: Plan): Plan {
    const preview = this._preview;
    if (!preview) return plan;
    return {
      ...plan,
      week: {
        day_types: plan.week.day_types.map((dt) =>
          dt.id === preview.dayTypeId
            ? { ...dt, blocks: dt.blocks.map((b, i) => (i === preview.index ? preview.block : b)) }
            : dt,
        ),
      },
    };
  }

  private _copyDay(fromId: string): void {
    const targets = this._copyTargets;
    if (!targets.length) return;
    this._updatePlan((plan) => copyDayType(plan, fromId, targets))
      .then(() => {
        this._copyOpen = false;
        this._copyTargets = [];
      })
      .catch((err) => this._notify(this._l.t("save_failed", { error: errorMessage(err) })));
  }

  private _onTrackDown(row: GridRow, ev: PointerEvent): void {
    if (ev.button !== 0 || !row.dayType || (ev.target as HTMLElement).closest(".block")) return;
    this._cancelPress();
    const track = ev.currentTarget as HTMLElement;
    const { clientX, clientY } = ev;
    const timer = window.setTimeout(() => {
      this._press = undefined;
      const rect = track.getBoundingClientRect();
      const minute = ((clientX - rect.left) / rect.width) * MINUTES_PER_DAY;
      this._newBlockAt(row.dayType!, minute);
    }, LONG_PRESS_MS);
    this._press = { timer, x: clientX, y: clientY };
  }

  private _onTrackMove(ev: PointerEvent): void {
    if (!this._press) return;
    if (Math.hypot(ev.clientX - this._press.x, ev.clientY - this._press.y) > 8) this._cancelPress();
  }

  private _cancelPress(): void {
    if (this._press) window.clearTimeout(this._press.timer);
    this._press = undefined;
  }

  private _newBlockAt(dayType: DayType, minute: number): void {
    if (!this._plan) return;
    const step = this._step;
    const start = clamp(snap(minute, step), 0, MINUTES_PER_DAY - step);
    if (blockAt(dayType.blocks, start) >= 0) return;
    const end = Math.min(start + 120, freeUntil(dayType.blocks, start), MINUTES_PER_DAY);
    const profile =
      this._plan.profiles.find((p) => p.id !== this._plan!.default_profile) ??
      this._plan.profiles[0];
    navigator.vibrate?.(10);
    this._tab = dayType.id;
    this._openEditor({
      dayTypeId: dayType.id,
      index: -1,
      block: { start: formatTime(start), end: formatTime(end), profile: profile.id },
    });
  }

  private async _saveBlocks(changes: Record<string, (blocks: Block[]) => Block[]>): Promise<void> {
    this._busy = true;
    this._saveError = null;
    try {
      await this._updatePlan((plan) => {
        for (const dt of plan.week.day_types) {
          const change = changes[dt.id];
          if (change) dt.blocks = change(dt.blocks);
        }
      });
      this._editing = undefined;
    } catch (err) {
      this._saveError = this._l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  private _onSave(ev: CustomEvent<BlockSaveDetail>): void {
    const { target, block, also } = ev.detail;
    const def = this._plan!.default_profile;
    const changes: Record<string, (blocks: Block[]) => Block[]> = {
      [target.dayTypeId]: (blocks) =>
        target.index < 0
          ? insertBlock(blocks, block, def)
          : replaceBlock(blocks, target.index, block, def),
    };
    for (const id of also ?? []) {
      if (id !== target.dayTypeId) changes[id] = (blocks) => insertBlock(blocks, block, def);
    }
    this._saveBlocks(changes);
  }

  private _onDelete(ev: CustomEvent<{ target: BlockEditTarget }>): void {
    const { target } = ev.detail;
    this._saveBlocks({ [target.dayTypeId]: (blocks) => removeBlock(blocks, target.index) });
  }

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
    if (this._page === "rules") {
      return html`<ha-card>
        <zeitwerk-rules
          ?dark=${!!this.hass?.themes?.darkMode}
          .hass=${this.hass}
          .plan=${plan}
          .localize=${l}
          .save=${(m: PlanMutator) => this._updatePlan(m)}
          @zw-back=${() => (this._page = "week")}
        ></zeitwerk-rules>
      </ha-card>`;
    }
    return html`<ha-card class=${this._config!.compact ? "compact" : ""}>
      ${this._renderHeader(plan)} ${this._renderChips(plan)}
      ${
        quick.length
          ? html`${this._separator(l.t("section_profiles"))}
              <div class="sliders">${quick.map((q) => this._renderSlider(plan, q))}</div>`
          : nothing
      }
      ${this._separator(l.t("section_week"))} ${this._renderTabs(plan)} ${this._renderGrid(plan)}
      ${this._config!.compact ? nothing : this._renderRulesLinks(plan)}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
      ${this._editing ? this._renderEditor(plan, this._editing) : nothing}
    </ha-card>`;
  }

  private _separator(title: string) {
    return html`<div class="separator"><span>${title}</span><span class="line"></span></div>`;
  }

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

  private _renderChips(plan: Plan) {
    const l = this._l;
    const status = plan.status;
    const now = zonedNow(this.hass?.config?.time_zone);
    const dayType = plan.week.day_types.find((d) => d.id === status?.day_type);
    const dayText = [
      l.weekdayLong(now.weekdayIndex),
      status?.is_holiday ? l.t("holiday") : null,
      dayType?.name,
    ]
      .filter(Boolean)
      .join(" · ");

    let state: TemplateResult;
    if (!plan.enabled) {
      state = html`<span class="chip">${l.t("plan_off")}</span>`;
    } else if (status?.error) {
      state = html`<span class="chip bad">${l.t("plan_error")}</span>`;
    } else if (status && !status.active) {
      state = html`<span class="chip">${this._pausedText(plan)}</span>`;
    } else {
      state = html`<span class="chip ok"><span class="dot"></span>${l.t("plan_running")}</span>`;
    }

    let override: string = l.t("no_override");
    const source = status?.source ?? "";
    if (status?.forced_until) {
      const forced = this._profile(status.profile);
      override = l.t("forced_until", {
        profile: forced?.name ?? "",
        time: zonedClock(status.forced_until, this.hass?.config?.time_zone),
      });
    } else if (source.startsWith("override:")) {
      const ov = plan.overrides.find((o) => o.id === source.slice(9));
      override = l.t("override_active", { name: ov?.name ?? source.slice(9) });
    }
    const tz = this.hass?.config?.time_zone;
    const manual = status?.manual_since
      ? html`<span class="chip manual"
          >${
            status.manual_until
              ? l.t("manual_until", { time: zonedClock(status.manual_until, tz) })
              : l.t("manual")
          }</span
        >`
      : nothing;
    return html`<div class="chips">
      <span class="chip"><ha-icon icon="mdi:calendar-blank-outline"></ha-icon>${dayText}</span>
      ${state} ${manual}
      <span class="chip muted">${override}</span>
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
    const row = (icon: string, title: string, sub: string) =>
      html`<button class="link" @click=${() => (this._page = "rules")}>
        <span class="licon"><ha-icon .icon=${icon}></ha-icon></span>
        <span class="ltext"
          ><span class="ltitle">${title}</span><span class="lsub">${sub}</span></span
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
    return html`${this._separator(l.t("section_rules"))}
      <div class="links">
        ${row("mdi:layers-outline", l.t("rules_overrides"), overrides)}
        ${row("mdi:flash-outline", l.t("rules_activation"), activation)}
        ${row("mdi:flag-outline", l.t("rules_holidays"), this._holidaySummary(plan))}
      </div>`;
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
      input = html`<input
        type="range"
        min=${control.min}
        max=${control.max}
        step=${control.step}
        .value=${String(n)}
        aria-label=${profile.name}
        aria-valuetext=${value}
        @input=${(ev: Event) => this._onSlider(row, ev)}
      />`;
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
    return html`<div class="slider">
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

  private _tabs(plan: Plan): { id: string; name: string; sub: string }[] {
    const l = this._l;
    const holidayTypeId = plan.holidays.mode === "own_day_type" ? plan.holidays.day_type : null;
    const shown = plan.week.day_types.filter((dt) => dt.days.length || dt.id === holidayTypeId);
    const tabs = shown.map((dt) => ({
      id: dt.id,
      name: dt.name,
      sub:
        dt.id === holidayTypeId
          ? l.t("holiday_days")
          : daysLabel(
              dt.days.map((d) => WEEKDAYS.indexOf(d)),
              l,
            ),
    }));
    if (plan.holidays.mode === "like_day" && plan.holidays.like_day) {
      tabs.push({
        id: HOLIDAY_LIKE_TAB,
        name: l.t("holiday"),
        sub: l.t("holiday_like", { day: l.weekdayShort(WEEKDAYS.indexOf(plan.holidays.like_day)) }),
      });
    }
    return tabs;
  }

  private _selectedTab(plan: Plan): string | undefined {
    const tabs = this._tabs(plan);
    if (this._tab && tabs.some((t) => t.id === this._tab)) return this._tab;
    const today = plan.status?.day_type;
    return tabs.find((t) => t.id === today)?.id ?? tabs[0]?.id;
  }

  private _renderTabs(plan: Plan) {
    const tabs = this._tabs(plan);
    if (tabs.length < 2) return nothing;
    const selected = this._selectedTab(plan);
    return html`<div class="tabs" role="tablist" aria-label=${this._l.t("day_type_tabs")}>
      ${tabs.map(
        (t) =>
          html`<button
            role="tab"
            aria-selected=${t.id === selected ? "true" : "false"}
            @click=${() => (this._tab = t.id)}
          >
            <span class="tname">${t.name}</span><span class="tsub">${t.sub}</span>
          </button>`,
      )}
    </div>`;
  }

  private _rows(plan: Plan): GridRow[] {
    const l = this._l;
    const selected = this._selectedTab(plan);
    const now = zonedNow(this.hass?.config?.time_zone);
    const likeDay = plan.holidays.mode === "like_day" ? plan.holidays.like_day : null;
    const rows: GridRow[] = WEEKDAYS.map((wd, i) => {
      const dayType = dayTypeFor(plan, wd);
      const active =
        selected === HOLIDAY_LIKE_TAB ? wd === likeDay : !!dayType && dayType.id === selected;
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
          active: holiday.id === selected,
          today: !!plan.status?.is_holiday,
          dayOffset: null,
        });
      }
    }
    return rows;
  }

  private _renderGrid(realPlan: Plan) {
    const plan = this._shownPlan(realPlan);
    const l = this._l;
    const def = profileColor(plan, plan.default_profile);
    const rows = this._rows(plan);
    const status = plan.status;
    const tz = this.hass?.config?.time_zone;
    const now = zonedNow(tz);
    let nextText = l.t("no_next_change");
    if (status?.next_change) {
      const when = new Date(status.next_change);
      const sameDay =
        zonedNow(tz, when).weekdayIndex === now.weekdayIndex &&
        when.getTime() - Date.now() < 86_400_000;
      const time = zonedClock(status.next_change, tz);
      const next = this._profile(status.next_profile);
      nextText = l.t("next_change", {
        time: sameDay ? time : `${l.weekdayShort(zonedNow(tz, when).weekdayIndex)} ${time}`,
        profile: next?.name ?? status.next_profile ?? "",
      });
    }
    const used = new Set(plan.week.day_types.flatMap((d) => d.blocks.map((b) => b.profile)));
    const legend = plan.profiles.filter((p) => used.has(p.id) && p.id !== plan.default_profile);
    const defaultProfile = this._profile(plan.default_profile);

    return html`<div class="grid">
      <div class="axis">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
      <div class="rows">
        ${rows.map(
          (row) =>
            html`<div class="row ${row.active ? "" : "dim"}">
              <span class="day ${row.today ? "today" : ""}">${row.label}</span>
              <div
                class="track"
                style="background:${tint(def, 16)}"
                @pointerdown=${(ev: PointerEvent) => this._onTrackDown(row, ev)}
                @pointermove=${this._onTrackMove}
                @pointerup=${this._cancelPress}
                @pointercancel=${this._cancelPress}
                @pointerleave=${this._cancelPress}
                @contextmenu=${(ev: Event) => ev.preventDefault()}
              >
                ${row.segments.map((seg) => this._renderBlock(plan, seg, row.key))}
                ${this._renderManual(plan, row)} ${this._renderTip(row)}
              </div>
            </div>`,
        )}
        <div class="now-line" aria-hidden="true"></div>
        <div class="now-dot" aria-hidden="true"></div>
      </div>
      <div class="caption">
        <span class="cdot"></span>
        <span
          ><span class="now-time">${l.t("now", { time: formatTime(now.minutes) })}</span> ·
          ${nextText}</span
        >
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
              ${this._renderCopy(realPlan)}
              <div class="hint">${l.t("hint_drag", { step: this._step })}</div>`
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

  private _renderTip(row: GridRow) {
    const p = this._preview;
    if (!p || p.rowKey !== row.key || !p.edge || p.edge === "move") return nothing;
    const time = p.edge === "start" ? p.block.start : p.block.end;
    const iv = toInterval(p.block);
    const at = p.edge === "start" ? iv.start : iv.end % MINUTES_PER_DAY || MINUTES_PER_DAY;
    return html`<div class="tip" style="left:${(at / MINUTES_PER_DAY) * 100}%">${time}</div>`;
  }

  private _renderCopy(plan: Plan) {
    const l = this._l;
    const selected = this._selectedTab(plan);
    const from = plan.week.day_types.find((d) => d.id === selected);
    if (!from || !this.hass?.user?.is_admin) return nothing;
    const others = plan.week.day_types.filter(
      (d) =>
        d.id !== from.id &&
        (d.days.length ||
          (plan.holidays.mode === "own_day_type" && d.id === plan.holidays.day_type)),
    );
    if (!others.length) return nothing;
    if (!this._copyOpen) {
      return html`<button class="textbtn" @click=${() => (this._copyOpen = true)}>
        ${l.t("copy_day", { name: from.name })}
      </button>`;
    }
    return html`<div class="copy">
      <span class="copy-title">${l.t("copy_day", { name: from.name })}</span>
      <div class="chiprow">
        ${others.map((d) => {
          const on = this._copyTargets.includes(d.id);
          return html`<button
            class="pick"
            aria-pressed=${on ? "true" : "false"}
            @click=${() =>
              (this._copyTargets = on
                ? this._copyTargets.filter((x) => x !== d.id)
                : [...this._copyTargets, d.id])}
          >
            ${d.name}
          </button>`;
        })}
      </div>
      <span class="copy-hint">${l.t("copy_hint")}</span>
      <div class="copy-actions">
        <button
          class="textbtn"
          @click=${() => {
            this._copyOpen = false;
            this._copyTargets = [];
          }}
        >
          ${l.t("cancel")}
        </button>
        <button
          class="accent"
          ?disabled=${!this._copyTargets.length}
          @click=${() => this._copyDay(from.id)}
        >
          ${l.t("copy_confirm")}
        </button>
      </div>
    </div>`;
  }

  private _renderBlock(plan: Plan, seg: Segment, rowKey: string) {
    const color = profileColor(plan, seg.profile);
    const profile = this._profile(seg.profile);
    const block = plan.week.day_types.find((d) => d.id === seg.dayType)?.blocks[seg.index];
    const crossing = block ? toInterval(block).end > MINUTES_PER_DAY : false;
    const startEdge = !seg.spill;
    const endEdge = crossing ? seg.spill : !seg.spill;
    const dragging = this._preview?.dayTypeId === seg.dayType && this._preview.index === seg.index;
    return html`<button
      class="block ${seg.spill ? "spill" : ""} ${dragging ? "dragging" : ""}"
      style="left:${seg.left}%;width:${seg.width}%;background:${color};color:${textOn(color)}"
      aria-label=${this._l.t("edit_block", { profile: profile?.name ?? seg.profile, time: seg.label })}
      @click=${() => this._onBlockClick(seg)}
      @keydown=${(ev: KeyboardEvent) => this._onBlockKey(seg, ev)}
    >
      <span class="blabel">${seg.width >= seg.label.length * 2.1 ? seg.label : ""}</span>
      ${
        startEdge
          ? html`<span
              class="edge start"
              aria-hidden="true"
              @pointerdown=${(ev: PointerEvent) => this._onEdgeDown(seg, "start", rowKey, ev)}
            ></span>`
          : nothing
      }
      ${
        endEdge
          ? html`<span
              class="edge end"
              aria-hidden="true"
              @pointerdown=${(ev: PointerEvent) => this._onEdgeDown(seg, "end", rowKey, ev)}
            ></span>`
          : nothing
      }
    </button>`;
  }

  private _renderEditor(plan: Plan, target: BlockEditTarget) {
    const dt = plan.week.day_types.find((d) => d.id === target.dayTypeId);
    const labels: Record<string, string> = {};
    for (const p of plan.profiles) labels[p.id] = this._valueLabel(p);
    return html`<zeitwerk-block-editor
      ?dark=${!!this.hass?.themes?.darkMode}
      .plan=${plan}
      .target=${target}
      .localize=${this._l}
      .valueLabels=${labels}
      .dayTypeLabel=${dt ? this._dayTypeLabel(dt) : ""}
      .otherDayTypes=${plan.week.day_types
        .filter(
          (d) =>
            d.id !== target.dayTypeId &&
            (d.days.length ||
              (plan.holidays.mode === "own_day_type" && d.id === plan.holidays.day_type)),
        )
        .map((d) => ({ id: d.id, name: d.name }))}
      .step=${this._step}
      .error=${this._saveError}
      .busy=${this._busy}
      @zw-close=${() => (this._editing = undefined)}
      @zw-save=${this._onSave}
      @zw-delete=${this._onDelete}
    ></zeitwerk-block-editor>`;
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
      .chip.bad {
        background: color-mix(in srgb, var(--zw-danger) 14%, transparent);
        color: var(--zw-danger);
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
      .slider input,
      .slider .overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        touch-action: pan-y;
      }

      /* Day type tabs */
      .tabs {
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: 24px;
        background: var(--zw-surface);
      }
      .tabs button {
        flex: 1;
        min-width: 0;
        height: 44px;
        border-radius: 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
      }
      .tabs button[aria-selected="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
      }
      .tname {
        font-size: 13px;
        font-weight: 600;
      }
      .tsub {
        font-size: 11px;
        opacity: 0.65;
      }

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
      }
      .row.dim {
        opacity: 0.32;
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
      .caption {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .cdot {
        width: 8px;
        height: 8px;
        border-radius: 4px;
        background: var(--zw-text);
        flex-shrink: 0;
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
      .edge {
        position: absolute;
        top: -7px;
        bottom: -7px;
        width: 22px;
        touch-action: none;
        cursor: ew-resize;
      }
      .block .edge {
        pointer-events: auto;
      }
      .edge.start {
        left: -11px;
      }
      .edge.end {
        right: -11px;
      }
      .edge::after {
        content: "";
        position: absolute;
        top: 13px;
        bottom: 13px;
        left: 9px;
        width: 4px;
        border-radius: 2px;
        background: currentColor;
        opacity: 0;
      }
      .block:hover .edge::after,
      .block:focus-visible .edge::after,
      .block.dragging .edge::after {
        opacity: 0.55;
      }
      .block.dragging {
        z-index: 2;
        outline: 2px solid var(--zw-text);
      }
      .block {
        overflow: visible;
      }
      .tip {
        position: absolute;
        bottom: calc(100% + 6px);
        transform: translateX(-50%);
        padding: 3px 8px;
        border-radius: 8px;
        background: var(--zw-text);
        color: var(--zw-bg);
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
        pointer-events: none;
        z-index: 3;
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
      .copy-title {
        font-size: 13px;
        font-weight: 600;
      }
      .copy-hint {
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .chiprow {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pick {
        height: 36px;
        padding: 0 14px;
        border-radius: 18px;
        border: 1px solid color-mix(in srgb, var(--zw-text) 18%, transparent);
        font-size: 13px;
      }
      .pick[aria-pressed="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
        border-color: var(--zw-accent);
      }
      .copy-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        align-items: center;
      }
      .accent {
        height: 36px;
        padding: 0 18px;
        border-radius: 18px;
        background: var(--zw-accent);
        color: var(--zw-on-accent);
        font-weight: 700;
        font-size: 13px;
      }
      .accent:disabled {
        opacity: 0.5;
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
      .chip.manual {
        background: repeating-linear-gradient(
          135deg,
          var(--zw-surface-2) 0 4px,
          var(--zw-surface) 4px 8px
        );
      }
      .links {
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        overflow: hidden;
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
