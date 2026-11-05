/**
 * Day editor (in-card page): all blocks of one day on a 24 h bar. Add, delete,
 * drag; changes stay local until "Speichern", which applies the day plan to
 * the selected days (their old blocks are replaced).
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { profileColor, textOn, tint } from "./colors";
import {
  addBlock,
  dragDayBlock,
  fromDayBlocks,
  toDayBlocks,
  type DayBlock,
  type DayKey,
  type DragMode,
} from "./day-plan";
import { canvasMeasure, fitLabel, observeWidth, type TextMeasure } from "./labels";
import type { Localizer } from "./localize";
import { pageStyles, tokens } from "./styles";
import { MINUTES_PER_DAY, formatTime } from "./time";
import { WEEKDAYS, type Block, type Plan } from "./types";

export interface DaySaveDetail {
  day: DayKey;
  blocks: Block[];
  targets: DayKey[];
}

const HANDLE_HIT_PX = 22;

export class ZeitwerkDayEditor extends LitElement {
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public day!: DayKey;
  @property({ attribute: false }) public initial: Block[] = [];
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public valueLabels: Record<string, string> = {};
  /** Whether the plan has its own holiday day ("Feiertag" can be a target). */
  @property({ attribute: false }) public withHoliday = false;
  @property({ type: Number }) public step = 15;
  @property({ attribute: false }) public error: string | null = null;
  @property({ type: Boolean }) public busy = false;

  @state() private _blocks: DayBlock[] = [];
  @state() private _selected = -1;
  @state() private _targets: DayKey[] = [];
  @state() private _dirty = false;
  @state() private _confirmDiscard = false;
  @state() private _tip?: { at: number; text: string };
  private _drag?: {
    index: number;
    mode: DragMode;
    x0: number;
    width: number;
    original: DayBlock[];
  };
  private _tapStart?: { x: number; minute: number };
  @state() private _barPx = 0;
  private _barObs?: { el: Element; stop: () => void };
  private _measure?: TextMeasure;

  protected updated(): void {
    const bar = this.renderRoot.querySelector(".bar");
    if (bar !== this._barObs?.el) {
      this._barObs?.stop();
      this._barObs = bar
        ? { el: bar, stop: observeWidth(bar, (w) => (this._barPx = w)) }
        : undefined;
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._barObs?.stop();
    this._barObs = undefined;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("day") || changed.has("initial")) {
      this._blocks = toDayBlocks(this.initial);
      this._selected = this._blocks.length ? 0 : -1;
      this._targets = [this.day];
      this._dirty = false;
      this._confirmDiscard = false;
    }
  }

  protected firstUpdated(): void {
    this.scrollIntoView?.({ block: "nearest" });
  }

  private _fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private _dayName(day: DayKey): string {
    return day === "holiday"
      ? this.localize.t("holiday")
      : this.localize.weekdayLong(WEEKDAYS.indexOf(day));
  }

  private _dayShort(day: DayKey): string {
    return day === "holiday"
      ? this.localize.t("holiday_short")
      : this.localize.weekdayShort(WEEKDAYS.indexOf(day));
  }

  private _change(blocks: DayBlock[], selected = this._selected): void {
    this._blocks = blocks;
    this._selected = selected;
    this._dirty = true;
    this._confirmDiscard = false;
  }

  private get _defaultNewProfile(): string {
    const p =
      this.plan.profiles.find((x) => x.id !== this.plan.default_profile) ?? this.plan.profiles[0];
    return p.id;
  }

  private _add(minute?: number): void {
    const res = addBlock(this._blocks, this._defaultNewProfile, this.step, minute);
    if (res) this._change(res.blocks, res.index);
  }

  private _remove(): void {
    if (this._selected < 0) return;
    const blocks = this._blocks.filter((_, i) => i !== this._selected);
    this._change(blocks, Math.min(this._selected, blocks.length - 1));
  }

  private _setProfile(profile: string): void {
    if (this._selected < 0) return;
    this._change(this._blocks.map((b, i) => (i === this._selected ? { ...b, profile } : b)));
  }

  private _shift(mode: "start" | "end", delta: number): void {
    if (this._selected < 0) return;
    this._change(dragDayBlock(this._blocks, this._selected, mode, delta, this.step));
  }

  // --- Bar interaction ----------------------------------------------------------

  private _minuteAt(ev: PointerEvent, rect: DOMRect): number {
    return Math.max(
      0,
      Math.min(MINUTES_PER_DAY, ((ev.clientX - rect.left) / rect.width) * MINUTES_PER_DAY),
    );
  }

  private _onBarDown(ev: PointerEvent): void {
    const bar = ev.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const minute = this._minuteAt(ev, rect);
    const px = (m: number) => rect.left + (m / MINUTES_PER_DAY) * rect.width;
    // Edge of the selected block first (largest touch target), then any block.
    let hit: { index: number; mode: DragMode } | undefined;
    const sel = this._blocks[this._selected];
    if (sel) {
      const ds = Math.abs(ev.clientX - px(sel.start));
      const de = Math.abs(ev.clientX - px(sel.end));
      if (Math.min(ds, de) <= HANDLE_HIT_PX)
        hit = { index: this._selected, mode: ds <= de ? "start" : "end" };
    }
    if (!hit) {
      const index = this._blocks.findIndex((b) => minute >= b.start && minute < b.end);
      if (index >= 0) hit = { index, mode: "move" };
    }
    if (!hit) {
      this._tapStart = { x: ev.clientX, minute };
      return;
    }
    ev.preventDefault();
    bar.setPointerCapture?.(ev.pointerId);
    this._selected = hit.index;
    this._drag = { ...hit, x0: ev.clientX, width: rect.width, original: this._blocks };
  }

  private _onBarMove(ev: PointerEvent): void {
    const drag = this._drag;
    if (!drag) return;
    const delta = ((ev.clientX - drag.x0) / drag.width) * MINUTES_PER_DAY;
    if (Math.abs(ev.clientX - drag.x0) < 3) return;
    const blocks = dragDayBlock(drag.original, drag.index, drag.mode, delta, this.step);
    const b = blocks[drag.index];
    const at = drag.mode === "end" ? b.end : b.start;
    this._tip = {
      at,
      text: drag.mode === "move" ? `${formatTime(b.start)}–${formatTime(b.end)}` : formatTime(at),
    };
    this._change(blocks, drag.index);
  }

  private _onBarUp(ev: PointerEvent): void {
    this._drag = undefined;
    this._tip = undefined;
    const tap = this._tapStart;
    this._tapStart = undefined;
    if (tap && Math.abs(ev.clientX - tap.x) < 8) this._add(tap.minute);
  }

  // --- Save / discard -------------------------------------------------------------

  private _close(): void {
    if (this._dirty && !this._confirmDiscard) {
      this._confirmDiscard = true;
      return;
    }
    this._fire("zw-close");
  }

  private _save(): void {
    this._fire("zw-save-day", {
      day: this.day,
      blocks: fromDayBlocks(this._blocks),
      targets: this._targets,
    } satisfies DaySaveDetail);
  }

  private _toggleTarget(day: DayKey): void {
    if (day === this.day) return;
    this._targets = this._targets.includes(day)
      ? this._targets.filter((d) => d !== day)
      : [...this._targets, day];
  }

  private _quick(days: DayKey[]): void {
    const all = days.every((d) => this._targets.includes(d));
    const set = new Set(this._targets);
    for (const d of days) {
      if (d === this.day) continue;
      if (all) set.delete(d);
      else set.add(d);
    }
    this._targets = [...set];
  }

  // --- Rendering ------------------------------------------------------------------

  private _bar() {
    const def = profileColor(this.plan, this.plan.default_profile);
    const pct = (m: number) => (m / MINUTES_PER_DAY) * 100;
    return html`<div class="barwrap">
      <div
        class="bar"
        style="background:${tint(def, 16)}"
        @pointerdown=${this._onBarDown}
        @pointermove=${this._onBarMove}
        @pointerup=${this._onBarUp}
        @pointercancel=${() => ((this._drag = undefined), (this._tip = undefined))}
      >
        ${this._blocks.map((b, i) => {
          const color = profileColor(this.plan, b.profile);
          const label = `${formatTime(b.start)}–${formatTime(b.end)}`;
          const width = pct(b.end - b.start);
          const measure = (this._measure ??= canvasMeasure(
            `700 11px ${getComputedStyle(this).fontFamily || "sans-serif"}`,
          ));
          return html`<div
            class="blk ${i === this._selected ? "sel" : ""}"
            title=${label}
            style="left:${pct(b.start)}%;width:${width}%;background:${color};color:${textOn(color)}"
          >
            <span class="blabel"
              >${fitLabel([label, formatTime(b.start)], (width / 100) * this._barPx, measure)}</span
            >
            ${
              i === this._selected
                ? html`<span class="handle start"></span><span class="handle end"></span>`
                : nothing
            }
          </div>`;
        })}
        ${
          this._tip
            ? html`<div class="tip" style="left:${pct(this._tip.at)}%">${this._tip.text}</div>`
            : nothing
        }
      </div>
      <div class="axis">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>`;
  }

  private _selectedPanel() {
    const t = this.localize.t.bind(this.localize);
    const b = this._blocks[this._selected];
    if (!b) {
      return html`<div class="empty">
        ${t("no_blocks", {
          profile: this.plan.profiles.find((p) => p.id === this.plan.default_profile)?.name ?? "",
        })}
      </div>`;
    }
    const stepper = (which: "start" | "end") => {
      const field = t(which);
      return html`<div class="field">
        <span class="label">${field}</span>
        <div class="stepper">
          <button
            aria-label=${t("earlier", { field, step: this.step })}
            @click=${() => this._shift(which, -this.step)}
          >
            −
          </button>
          <span class="time">${formatTime(which === "start" ? b.start : b.end)}</span>
          <button
            aria-label=${t("later", { field, step: this.step })}
            @click=${() => this._shift(which, this.step)}
          >
            +
          </button>
        </div>
      </div>`;
    };
    return html`<div class="panel">
      <div class="field">
        <span class="label">${t("profile")}</span>
        <div class="profiles">
          ${this.plan.profiles.map((p) => {
            const color = profileColor(this.plan, p);
            const on = p.id === b.profile;
            return html`<button
              class="profile"
              aria-pressed=${on ? "true" : "false"}
              style="border-color:${on ? color : "var(--zw-surface-2)"};background:${on ? tint(color, 14) : "var(--zw-surface)"}"
              @click=${() => this._setProfile(p.id)}
            >
              <span class="dot" style="background:${color}"></span>
              <span class="pname">${p.name}</span>
              <span class="pvalue">${this.valueLabels[p.id] ?? ""}</span>
            </button>`;
          })}
        </div>
      </div>
      <div class="row">${stepper("start")} ${stepper("end")}</div>
      <button class="textdanger" @click=${this._remove}>${t("delete_block")}</button>
    </div>`;
  }

  protected render() {
    if (!this.plan || !this.localize || !this.day) return nothing;
    const t = this.localize.t.bind(this.localize);
    const days: DayKey[] = [...WEEKDAYS, ...(this.withHoliday ? (["holiday"] as DayKey[]) : [])];
    const others = this._targets.filter((d) => d !== this.day);
    return html`<div
      class="page"
      role="region"
      aria-label=${t("day_editor_title", { day: this._dayName(this.day) })}
    >
      <div class="head">
        <div class="titles">
          <span class="title">${t("day_editor_title", { day: this._dayName(this.day) })}</span>
          <span class="context">${this.plan.name}</span>
        </div>
        <button class="round" aria-label=${t("close")} @click=${this._close}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      ${this._bar()}
      <div class="barbar">
        <span class="hint">${t("day_bar_hint")}</span>
        <button class="add" @click=${() => this._add()}>${t("add_block")}</button>
      </div>

      ${this._selectedPanel()}

      <div class="field">
        <span class="label">${t("apply_to")}</span>
        <div class="chips">
          ${days.map((d) => {
            const on = this._targets.includes(d);
            return html`<button
              class="chip ${d === this.day ? "fixed" : ""}"
              aria-pressed=${on ? "true" : "false"}
              aria-label=${this._dayName(d)}
              ?disabled=${d === this.day}
              @click=${() => this._toggleTarget(d)}
            >
              ${this._dayShort(d)}
            </button>`;
          })}
        </div>
        <div class="quick">
          <button @click=${() => this._quick(["mon", "tue", "wed", "thu", "fri"])}>
            ${t("quick_weekdays")}
          </button>
          <button @click=${() => this._quick(["sat", "sun"])}>${t("quick_weekend")}</button>
          <button @click=${() => this._quick([...WEEKDAYS])}>${t("quick_all")}</button>
        </div>
        ${
          others.length
            ? html`<span class="hint warn">
                ${t("apply_hint", { days: others.map((d) => this._dayShort(d)).join(", ") })}
              </span>`
            : nothing
        }
      </div>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this._confirmDiscard ? html`<div class="error" role="alert">${t("discard_changes")}</div>` : nothing}

      <div class="actions">
        <button class="danger" ?disabled=${this.busy} @click=${this._close}>
          ${this._confirmDiscard ? t("discard") : t("cancel")}
        </button>
        <button class="primary" ?disabled=${this.busy} @click=${this._save}>${t("save")}</button>
      </div>
    </div>`;
  }

  static styles = [
    tokens,
    pageStyles,
    css`
      :host {
        display: block;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .title {
        font-size: 20px;
        font-weight: 700;
      }
      .context,
      .label,
      .hint,
      .empty {
        font-size: 13px;
        color: var(--zw-text-2);
      }
      .label {
        font-weight: 600;
      }
      .hint {
        font-size: 12px;
      }
      .hint.warn {
        color: var(--zw-text);
      }
      button {
        -webkit-tap-highlight-color: transparent;
        cursor: pointer;
        border: 0;
        background: none;
        padding: 0;
        font: inherit;
        color: inherit;
      }
      button:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      button:disabled {
        cursor: default;
      }
      .round,
      .stepper button {
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        border-radius: 22px;
        background: var(--zw-surface-2);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
      }
      .barwrap {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 24px;
      }
      .bar {
        position: relative;
        height: 56px;
        border-radius: 14px;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        cursor: pointer;
      }
      .blk {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        box-sizing: border-box;
      }
      .blk.sel {
        outline: 2px solid var(--zw-text);
        outline-offset: 1px;
        z-index: 1;
      }
      .blabel {
        overflow: hidden;
        white-space: nowrap;
        pointer-events: none;
      }
      .handle {
        position: absolute;
        top: 10px;
        bottom: 10px;
        width: 10px;
        border-radius: 5px;
        background: var(--zw-text);
        box-shadow: 0 0 0 2px var(--zw-bg);
      }
      .handle.start {
        left: -5px;
      }
      .handle.end {
        right: -5px;
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
        z-index: 2;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .barbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .add {
        flex-shrink: 0;
        height: 40px;
        padding: 0 16px;
        border-radius: 20px;
        border: 1px dashed color-mix(in srgb, var(--zw-text) 30%, transparent);
        font-size: 13px;
        font-weight: 600;
      }
      .panel {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 14px;
        border-radius: 22px;
        background: var(--zw-surface);
      }
      .field {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .profiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
        gap: 8px;
      }
      .profile {
        height: 60px;
        border-radius: 18px;
        border: 2px solid;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 6px;
      }
      .pname {
        font-size: 13px;
        font-weight: 600;
      }
      .pvalue {
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .row {
        display: flex;
        gap: 10px;
      }
      .stepper {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 52px;
        padding: 0 4px;
        border-radius: 26px;
        background: var(--zw-surface);
      }
      .time {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .textdanger {
        align-self: flex-start;
        color: var(--zw-danger);
        font-size: 13px;
        font-weight: 600;
        padding: 6px 2px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        min-width: 44px;
        height: 40px;
        padding: 0 10px;
        border-radius: 20px;
        border: 1px solid color-mix(in srgb, var(--zw-text) 18%, transparent);
        font-size: 13px;
        font-weight: 600;
      }
      .chip[aria-pressed="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
        border-color: var(--zw-accent);
      }
      .chip.fixed {
        opacity: 0.75;
      }
      .quick {
        display: flex;
        gap: 14px;
      }
      .quick button {
        font-size: 13px;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .actions button {
        height: 52px;
        border-radius: 26px;
        font-size: 15px;
      }
      .actions button:disabled {
        opacity: 0.5;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-day-editor": ZeitwerkDayEditor;
  }
}
