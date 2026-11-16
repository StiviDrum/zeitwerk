/** Week grid (7 rows + optional holiday row) with now-line, legend and manual-override hatch. */
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { profileColor, textOn, tint } from "./colors";
import { displayStyles, resumeMarks, syncDark } from "./display-ui";
import { canvasMeasure, fitLabel, observeWidth, type TextMeasure } from "./labels";
import { localizer, type Localizer } from "./localize";
import {
  dayName,
  gridRows,
  languageOf,
  manualSegment,
  type GridRow,
  type ViewCtx,
} from "./plan-view";
import { tokens } from "./styles";
import type { HomeAssistant, Plan } from "./types";

export class ZeitwerkWeekGrid extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize?: Localizer;
  /** Rows are buttons that fire `zw-day` (otherwise the grid is display only). */
  @property({ type: Boolean }) public interactive = false;
  @property({ type: Boolean }) public compact = false;

  /** Width of a track in px (staged block labels). */
  @state() private _trackPx = 0;
  private _trackObs?: { el: Element; stop: () => void };
  private _measure?: TextMeasure;

  private get _ctx(): ViewCtx {
    return { hass: this.hass, l: this.localize ?? localizer(languageOf(this.hass)) };
  }

  protected willUpdate(): void {
    syncDark(this, this.hass);
  }

  protected updated(): void {
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

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._trackObs?.stop();
    this._trackObs = undefined;
  }

  private _open(day: GridRow["key"]): void {
    this.dispatchEvent(new CustomEvent("zw-day", { detail: day, bubbles: true, composed: true }));
  }

  private _track(plan: Plan, row: GridRow, ctx: ViewCtx) {
    const def = profileColor(plan, plan.default_profile);
    const measure = (this._measure ??= canvasMeasure(
      `700 11px ${getComputedStyle(this).fontFamily || "sans-serif"}`,
    ));
    return html`<span class="track" style="background:${tint(def, 16)}">
      ${row.segments.map((seg) => {
        const color = profileColor(plan, seg.profile);
        const px = (seg.width / 100) * this._trackPx;
        return html`<span
          class="block ${seg.spill ? "spill" : ""}"
          title="${seg.label} · ${plan.profiles.find((p) => p.id === seg.profile)?.name ?? seg.profile}"
          style="left:${seg.left}%;width:${seg.width}%;background:${color};color:${textOn(color)}"
          ><span class="blabel">${fitLabel([seg.label, seg.short], px, measure)}</span></span
        >`;
      })}
      ${this._manual(plan, row, ctx)} ${resumeMarks(ctx.l, row.dayType?.resume_points)}
    </span>`;
  }

  private _manual(plan: Plan, row: GridRow, ctx: ViewCtx) {
    if (row.dayOffset === null) return nothing;
    // On a holiday the hatch belongs to the holiday row, not the weekday row.
    if (plan.status?.is_holiday && plan.holidays.mode === "own_day_type") return nothing;
    const seg = manualSegment(ctx, plan, row.dayOffset);
    if (!seg) return nothing;
    return html`<div
      class="hatch"
      style="left:${seg.left}%;width:${seg.width}%"
      title=${ctx.l.t("manual")}
    ></div>`;
  }

  protected render() {
    const plan = this.plan;
    if (!plan) return nothing;
    const ctx = this._ctx;
    const l = ctx.l;
    const def = profileColor(plan, plan.default_profile);
    const rows = gridRows(ctx, plan);
    const used = new Set(plan.week.day_types.flatMap((d) => d.blocks.map((b) => b.profile)));
    const legend = plan.profiles.filter((p) => used.has(p.id) && p.id !== plan.default_profile);
    const defaultProfile = plan.profiles.find((p) => p.id === plan.default_profile);
    return html`<div class="grid ${this.compact ? "compact" : ""}">
      <div class="axis">
        ${[0, 6, 12, 18, 24].map((h) => html`<span style="left:${(h / 24) * 100}%">${h}</span>`)}
      </div>
      <div class="rows">
        ${rows.map((row) =>
          this.interactive
            ? html`<button
                class="row ${row.today ? "today" : ""}"
                aria-label=${l.t("day_editor_title", { day: dayName(l, row.key) })}
                @click=${() => this._open(row.key)}
              >
                <span class="day ${row.today ? "today" : ""}">${row.label}</span>
                ${this._track(plan, row, ctx)}
              </button>`
            : html`<div class="row static ${row.today ? "today" : ""}">
                <span class="day ${row.today ? "today" : ""}">${row.label}</span>
                ${this._track(plan, row, ctx)}
              </div>`,
        )}
        ${[0.25, 0.5, 0.75].map(
          (f) => html`<div class="hour-line" style="--zw-at:${f}" aria-hidden="true"></div>`,
        )}
        <div class="now-line" aria-hidden="true"></div>
        <div class="now-dot" aria-hidden="true"></div>
      </div>
      ${
        this.compact
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
              ${this.interactive ? html`<div class="hint">${l.t("tap_day_hint")}</div>` : nothing}`
      }
    </div>`;
  }

  static styles = [
    tokens,
    displayStyles,
    css`
      :host {
        display: block;
        --zw-track: 30px;
      }
      .grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 2px 2px 0;
      }
      .grid.compact {
        --zw-track: 22px;
      }
      .axis {
        position: relative;
        display: block;
        height: 14px;
        margin-left: 30px;
        font-size: 11px;
        color: var(--zw-text-2);
      }
      .axis span {
        position: absolute;
        transform: translateX(-50%);
      }
      .axis span:first-child {
        transform: none;
      }
      .axis span:last-child {
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
        border-radius: 10px;
        -webkit-tap-highlight-color: transparent;
      }
      button.row {
        cursor: pointer;
      }
      button.row:hover .track {
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
        overflow: visible;
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
      .hint {
        font-size: 12px;
        color: var(--zw-text-2);
        padding: 0 4px;
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
    `,
  ];
}
