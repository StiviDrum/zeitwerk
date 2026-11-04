/**
 * Block editor ("Block bearbeiten", docs/mockup/Editor.dc.html).
 *
 * Rendered as an in-card page, not as a modal <dialog>: modal dialogs fight
 * with Home Assistant's own dialogs (edit-card preview, pop-ups) over focus
 * and inertness, which could leave users stuck in the editor.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { dragBlock, type Edge } from "./blocks";
import { profileColor, tint } from "./colors";
import type { Localizer } from "./localize";
import { tokens } from "./styles";
import { MINUTES_PER_DAY, formatDuration, formatTime, parseTime } from "./time";
import type { Block, Plan, Weekday } from "./types";

export interface BlockEditTarget {
  dayTypeId: string;
  /** Index in the day type's blocks, -1 for a new block. */
  index: number;
  block: Block;
  /** Weekday row the block was opened from (enables "only this day"). */
  weekday?: Weekday;
}

export interface BlockSaveDetail {
  target: BlockEditTarget;
  block: Block;
  /** Other day types that get the same block. */
  also?: string[];
  /** Apply only to `target.weekday` (detach it from its day type). */
  onlyDay?: boolean;
}

const HANDLE_HIT_PX = 22;

export class ZeitwerkBlockEditor extends LitElement {
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public target!: BlockEditTarget;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public valueLabels: Record<string, string> = {};
  @property({ attribute: false }) public dayTypeLabel = "";
  /** Long name of `target.weekday`, e.g. "Mittwoch". */
  @property({ attribute: false }) public weekdayLabel = "";
  /** Whether the day type spans more than this one weekday. */
  @property({ attribute: false }) public sharedDayType = false;
  @property({ attribute: false }) public otherDayTypes: { id: string; name: string }[] = [];
  @property({ type: Number }) public step = 15;
  @property({ attribute: false }) public error: string | null = null;
  @property({ type: Boolean }) public busy = false;

  @state() private _start = 0;
  @state() private _end = 60;
  @state() private _profile = "";
  @state() private _also: string[] = [];
  @state() private _onlyDay = false;
  @state() private _confirmDelete = false;
  private _drag?: { edge: Edge; x0: number; width: number; original: Block };

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("target") && this.target) {
      this._start = parseTime(this.target.block.start) % MINUTES_PER_DAY;
      this._end = parseTime(this.target.block.end) || MINUTES_PER_DAY;
      this._profile = this.target.block.profile;
      this._also = [];
      this._onlyDay = false;
      this._confirmDelete = false;
    }
  }

  protected firstUpdated(): void {
    this.scrollIntoView?.({ block: "nearest" });
  }

  private _fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private get _block(): Block {
    return { start: formatTime(this._start), end: formatTime(this._end), profile: this._profile };
  }

  private _setBlock(block: Block): void {
    this._start = parseTime(block.start) % MINUTES_PER_DAY;
    this._end = parseTime(block.end) || MINUTES_PER_DAY;
  }

  /** Move a time by ±step on the circle; never start == end. */
  private _shift(which: "start" | "end", delta: number): void {
    const wrap = (m: number) => ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const other = which === "start" ? this._end % MINUTES_PER_DAY : this._start;
    let value = wrap((which === "start" ? this._start : this._end) + delta);
    if (value === other) value = wrap(value + delta);
    if (which === "start") this._start = value;
    else this._end = value || MINUTES_PER_DAY;
  }

  private get _duration(): number {
    return (this._end - this._start + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
  }

  // --- Drag on the preview bar ------------------------------------------------

  private _onBarDown(ev: PointerEvent): void {
    const bar = ev.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const x = (m: number) => rect.left + (m / MINUTES_PER_DAY) * rect.width;
    const startX = x(this._start);
    const endX = x(this._end % MINUTES_PER_DAY || MINUTES_PER_DAY);
    const dStart = Math.abs(ev.clientX - startX);
    const dEnd = Math.abs(ev.clientX - endX);
    let edge: Edge | undefined;
    if (Math.min(dStart, dEnd) <= HANDLE_HIT_PX) edge = dStart <= dEnd ? "start" : "end";
    else {
      const minute = ((ev.clientX - rect.left) / rect.width) * MINUTES_PER_DAY;
      const rel = (minute - this._start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      if (rel < this._duration) edge = "move";
    }
    if (!edge) return;
    ev.preventDefault();
    bar.setPointerCapture?.(ev.pointerId);
    this._drag = { edge, x0: ev.clientX, width: rect.width, original: this._block };
  }

  private _onBarMove(ev: PointerEvent): void {
    const drag = this._drag;
    if (!drag) return;
    const delta = ((ev.clientX - drag.x0) / drag.width) * MINUTES_PER_DAY;
    this._setBlock(dragBlock(drag.original, drag.edge, delta, this.step));
  }

  private _onBarUp(): void {
    this._drag = undefined;
  }

  // --- Actions ------------------------------------------------------------------

  private _save(): void {
    this._fire("zw-save", {
      target: this.target,
      block: this._block,
      also: this._also,
      onlyDay: this._onlyDay,
    } satisfies BlockSaveDetail);
  }

  private _delete(): void {
    if (!this._confirmDelete) {
      this._confirmDelete = true;
      return;
    }
    this._fire("zw-delete", { target: this.target, onlyDay: this._onlyDay });
  }

  // --- Rendering ----------------------------------------------------------------

  private _stepper(which: "start" | "end") {
    const t = this.localize.t.bind(this.localize);
    const field = t(which);
    const value = which === "start" ? this._start : this._end;
    return html`<div class="field">
      <span class="label">${field}</span>
      <div class="stepper">
        <button
          aria-label=${t("earlier", { field, step: this.step })}
          @click=${() => this._shift(which, -this.step)}
        >
          −
        </button>
        <span class="time">${formatTime(value)}</span>
        <button
          aria-label=${t("later", { field, step: this.step })}
          @click=${() => this._shift(which, this.step)}
        >
          +
        </button>
      </div>
    </div>`;
  }

  private _previewBar() {
    const color = profileColor(this.plan, this._profile);
    const def = profileColor(this.plan, this.plan.default_profile);
    const pct = (m: number) => `${(m / MINUTES_PER_DAY) * 100}%`;
    const end = this._start + this._duration;
    const parts: [number, number][] =
      end <= MINUTES_PER_DAY
        ? [[this._start, end]]
        : [
            [this._start, MINUTES_PER_DAY],
            [0, end - MINUTES_PER_DAY],
          ];
    return html`<div
      class="bar"
      style="background:${tint(def, 16)}"
      @pointerdown=${this._onBarDown}
      @pointermove=${this._onBarMove}
      @pointerup=${this._onBarUp}
      @pointercancel=${this._onBarUp}
    >
      ${parts.map(
        ([s, e], i) =>
          html`<div
            class="bar-block"
            style="left:${pct(s)};width:${pct(e - s)};background:${color}"
          >
            ${i === 0 ? html`<span class="handle start"></span>` : nothing}
            ${i === parts.length - 1 ? html`<span class="handle end"></span>` : nothing}
          </div>`,
      )}
    </div>`;
  }

  protected render() {
    if (!this.plan || !this.target || !this.localize) return nothing;
    const t = this.localize.t.bind(this.localize);
    const isNew = this.target.index < 0;
    const defaultProfile = this.plan.profiles.find((p) => p.id === this.plan.default_profile);
    const close = () => this._fire("zw-close");
    const scope = this.target.weekday && this.sharedDayType;
    return html`<div class="page" role="region" aria-label=${t("block_title")}>
      <div class="head">
        <div class="titles">
          <span class="title">${isNew ? t("new_block") : t("block_title")}</span>
          <span class="context">${this.plan.name} · ${this.dayTypeLabel}</span>
        </div>
        <button class="round" aria-label=${t("close")} @click=${close}>
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

      ${
        scope
          ? html`<div class="field">
              <span class="label">${t("applies_to")}</span>
              <div class="segmented" role="radiogroup" aria-label=${t("applies_to")}>
                <button
                  role="radio"
                  aria-checked=${this._onlyDay ? "false" : "true"}
                  @click=${() => (this._onlyDay = false)}
                >
                  ${this.dayTypeLabel}
                </button>
                <button
                  role="radio"
                  aria-checked=${this._onlyDay ? "true" : "false"}
                  @click=${() => (this._onlyDay = true)}
                >
                  ${t("only_day", { day: this.weekdayLabel })}
                </button>
              </div>
            </div>`
          : nothing
      }

      <div class="field">
        <span class="label">${t("profile")}</span>
        <div class="profiles">
          ${this.plan.profiles.map((p) => {
            const color = profileColor(this.plan, p);
            const on = p.id === this._profile;
            return html`<button
              class="profile"
              aria-pressed=${on ? "true" : "false"}
              style="border-color:${on ? color : "var(--zw-surface-2)"};background:${on ? tint(color, 14) : "var(--zw-surface)"}"
              @click=${() => (this._profile = p.id)}
            >
              <span class="dot" style="background:${color}"></span>
              <span class="pname">${p.name}</span>
              <span class="pvalue">${this.valueLabels[p.id] ?? ""}</span>
            </button>`;
          })}
        </div>
      </div>

      <div class="row">${this._stepper("start")} ${this._stepper("end")}</div>

      <div class="preview">
        ${this._previewBar()}
        <div class="axis">
          <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
        </div>
        <span class="hint">
          ${t("duration", {
            duration: formatDuration(this._duration),
            profile: defaultProfile?.name ?? this.plan.default_profile,
          })}
        </span>
        <span class="hint">${t("drag_bar_hint")}</span>
      </div>

      ${
        this.otherDayTypes.length && !this._onlyDay
          ? html`<div class="field">
              <span class="label">${t("also_for")}</span>
              <div class="chips">
                ${this.otherDayTypes.map((d) => {
                  const on = this._also.includes(d.id);
                  return html`<button
                    class="chip"
                    aria-pressed=${on ? "true" : "false"}
                    @click=${() =>
                      (this._also = on
                        ? this._also.filter((x) => x !== d.id)
                        : [...this._also, d.id])}
                  >
                    ${d.name}
                  </button>`;
                })}
              </div>
            </div>`
          : nothing
      }
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

      <div class="actions">
        ${
          isNew
            ? html`<button class="danger" ?disabled=${this.busy} @click=${close}>
                ${t("cancel")}
              </button>`
            : html`<button class="danger" ?disabled=${this.busy} @click=${this._delete}>
                ${this._confirmDelete ? t("confirm_delete") : t("delete")}
              </button>`
        }
        <button class="primary" ?disabled=${this.busy} @click=${this._save}>${t("save")}</button>
      </div>
    </div>`;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: 18px;
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
      .hint {
        font-size: 13px;
        color: var(--zw-text-2);
      }
      .label {
        font-weight: 600;
      }
      .hint {
        font-size: 12px;
      }
      button {
        cursor: pointer;
        border: 0;
        background: none;
        padding: 0;
      }
      button:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
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
      .field {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .segmented {
        display: flex;
        gap: 4px;
        padding: 3px;
        border-radius: 18px;
        background: var(--zw-surface);
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
      .profiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: 8px;
      }
      .profile {
        height: 64px;
        border-radius: 20px;
        border: 2px solid;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
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
      .preview {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .bar {
        position: relative;
        height: 44px;
        border-radius: 12px;
        touch-action: none;
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
      }
      .bar-block {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 12px;
      }
      .handle {
        position: absolute;
        top: 8px;
        bottom: 8px;
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
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        height: 36px;
        padding: 0 14px;
        border-radius: 18px;
        border: 1px solid color-mix(in srgb, var(--zw-text) 18%, transparent);
        font-size: 13px;
      }
      .chip[aria-pressed="true"] {
        background: var(--zw-accent);
        color: var(--zw-on-accent);
        border-color: var(--zw-accent);
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
        margin-top: 4px;
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
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-block-editor": ZeitwerkBlockEditor;
  }
}
