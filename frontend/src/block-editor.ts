/**
 * Bottom sheet "Block bearbeiten" (docs/mockup/Editor.dc.html).
 *
 * Uses a native <dialog> opened with showModal(): it lives in the top layer,
 * so it is not clipped by transformed dashboard containers and inherits the
 * theme variables from the card.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { profileColor, tint } from "./colors";
import type { Localizer } from "./localize";
import { tokens } from "./styles";
import { MINUTES_PER_DAY, formatDuration, formatTime } from "./time";
import type { Block, Plan } from "./types";

export interface BlockEditTarget {
  dayTypeId: string;
  /** Index in the day type's blocks, -1 for a new block. */
  index: number;
  block: Block;
}

export interface BlockSaveDetail {
  target: BlockEditTarget;
  block: Block;
  /** Other day types that get the same block. */
  also?: string[];
}

@customElement("zeitwerk-block-editor")
export class ZeitwerkBlockEditor extends LitElement {
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public target!: BlockEditTarget;
  @property({ attribute: false }) public localize!: Localizer;
  @property({ attribute: false }) public valueLabels: Record<string, string> = {};
  @property({ attribute: false }) public dayTypeLabel = "";
  @property({ attribute: false }) public otherDayTypes: { id: string; name: string }[] = [];
  @state() private _also: string[] = [];
  @property({ type: Number }) public step = 15;
  @property({ attribute: false }) public error: string | null = null;
  @property({ type: Boolean }) public busy = false;

  @state() private _start = 0;
  @state() private _end = 60;
  @state() private _profile = "";

  @query("dialog") private _dialog?: HTMLDialogElement;

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("target") && this.target) {
      const [sh, sm] = this.target.block.start.split(":").map(Number);
      const [eh, em] = this.target.block.end.split(":").map(Number);
      this._start = (sh * 60 + sm) % MINUTES_PER_DAY;
      this._end = eh * 60 + em || MINUTES_PER_DAY;
      this._profile = this.target.block.profile;
    }
  }

  protected firstUpdated(): void {
    this._dialog?.showModal();
  }

  public close(): void {
    this._dialog?.close();
  }

  private _fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Move a time by ±step on the circle; start in [0,1440), end in (0,1440]; never start == end. */
  private _shift(which: "start" | "end", delta: number): void {
    const other = which === "start" ? this._end % MINUTES_PER_DAY : this._start;
    let value = which === "start" ? this._start : this._end % MINUTES_PER_DAY;
    value = (((value + delta) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (value === other)
      value = (((value + delta) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (which === "start") this._start = value;
    else this._end = value || MINUTES_PER_DAY;
  }

  private get _duration(): number {
    const d = (this._end - this._start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return d || MINUTES_PER_DAY;
  }

  private _save(): void {
    const block: Block = {
      start: formatTime(this._start),
      end: formatTime(this._end),
      profile: this._profile,
    };
    this._fire("zw-save", {
      target: this.target,
      block,
      also: this._also,
    } satisfies BlockSaveDetail);
  }

  private _onCancel(ev: Event): void {
    ev.preventDefault();
    this._fire("zw-close");
  }

  private _onBackdrop(ev: MouseEvent): void {
    if (ev.target === this._dialog) this._fire("zw-close");
  }

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
    return html`<div class="bar" style="background:${tint(def, 16)}">
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
    return html`<dialog
      aria-label=${t("block_title")}
      @cancel=${this._onCancel}
      @click=${this._onBackdrop}
    >
      <div class="sheet">
        <div class="grabber"></div>
        <div class="head">
          <div class="titles">
            <span class="title">${isNew ? t("new_block") : t("block_title")}</span>
            <span class="context">${this.plan.name} · ${this.dayTypeLabel}</span>
          </div>
          <button class="round" aria-label=${t("close")} @click=${() => this._fire("zw-close")}>
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
        </div>

        ${
          this.otherDayTypes.length
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
          <button
            class="danger"
            ?disabled=${this.busy}
            @click=${() => this._fire(isNew ? "zw-close" : "zw-delete", { target: this.target })}
          >
            ${isNew ? t("cancel") : t("delete")}
          </button>
          <button class="primary" ?disabled=${this.busy} @click=${this._save}>${t("save")}</button>
        </div>
      </div>
    </dialog>`;
  }

  static styles = [
    tokens,
    css`
      dialog {
        box-sizing: border-box;
        width: 100%;
        max-width: 520px;
        max-height: 100dvh;
        margin: auto auto 0;
        padding: 0;
        border: 0;
        border-top: 1px solid var(--zw-border);
        border-radius: 28px 28px 0 0;
        background: var(--zw-bg);
        color: var(--zw-text);
        overscroll-behavior: contain;
      }
      @media (min-width: 600px) {
        dialog {
          margin: auto;
          border-radius: 28px;
          border: 1px solid var(--zw-border);
        }
      }
      dialog::backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      .sheet {
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 10px 18px calc(24px + env(safe-area-inset-bottom, 0px));
      }
      .grabber {
        width: 40px;
        height: 4px;
        border-radius: 2px;
        background: var(--zw-surface-2);
        align-self: center;
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
        height: 36px;
        border-radius: 12px;
      }
      .bar-block {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 12px;
      }
      .handle {
        position: absolute;
        top: 6px;
        bottom: 6px;
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
        color: var(--zw-danger) !important;
        font-weight: 600;
      }
      .primary {
        flex: 2;
        background: var(--zw-accent) !important;
        color: var(--zw-on-accent) !important;
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
