/** One plan of the timeline: icon, name, current profile, next change and a 24 h band. */
import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { profileColor, tint } from "./colors";
import {
  displayStyles,
  fireNotice,
  resumeButton,
  resumePlan,
  resumeMarks,
  syncDark,
} from "./display-ui";
import { localizer, type Localizer } from "./localize";
import {
  languageOf,
  manualSegment,
  manualValue,
  valueLabel,
  whenText,
  type ViewCtx,
} from "./plan-view";
import { tokens } from "./styles";
import { MINUTES_PER_DAY, minutesFromToday } from "./time";
import type { HomeAssistant, Plan } from "./types";

export interface ScheduledSegment {
  start: string;
  end: string;
  profile: string;
}

export class ZeitwerkTimelinePlan extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize?: Localizer;
  /** Today's scheduled segments of the plan (from zeitwerk/preview). */
  @property({ attribute: false }) public segments: ScheduledSegment[] = [];

  private get _ctx(): ViewCtx {
    return { hass: this.hass, l: this.localize ?? localizer(languageOf(this.hass)) };
  }

  protected willUpdate(): void {
    syncDark(this, this.hass);
  }

  private _open = (): void => {
    this.dispatchEvent(
      new CustomEvent("zw-open", { detail: this.plan.id, bubbles: true, composed: true }),
    );
  };

  private _resume = async (ev: Event): Promise<void> => {
    ev.stopPropagation();
    if (!this.hass) return;
    fireNotice(this, await resumePlan(this.hass, this.plan, this._ctx.l));
  };

  protected render() {
    const plan = this.plan;
    if (!plan) return nothing;
    const ctx = this._ctx;
    const l = ctx.l;
    const tz = ctx.hass?.config?.time_zone;
    const status = plan.status;
    const current = plan.profiles.find((p) => p.id === status?.profile);
    const color = current ? profileColor(plan, current) : "var(--zw-text-2)";
    const isDefault = !current || current.id === plan.default_profile;
    const def = profileColor(plan, plan.default_profile);
    let sub: string;
    if (!plan.enabled) sub = l.t("plan_off");
    else if (status && !status.active && !current) sub = l.t("plan_paused");
    else if (status?.manual_since) {
      const value = manualValue(ctx, status);
      sub = value ? `${l.t("manual_cap")} · ${value}` : l.t("manual_cap");
    } else {
      const value = current ? valueLabel(ctx, current) : "";
      sub = current ? (value ? `${current.name} · ${value}` : current.name) : "";
    }
    let when = "";
    if (status?.manual_since && status.manual_until) {
      when = l.t("until_time", { time: whenText(ctx, status.manual_until) });
    } else if (status?.next_change) {
      const mins = Math.round((new Date(status.next_change).getTime() - Date.now()) / 60_000);
      when =
        mins >= 0 && mins < 60
          ? l.t("in_minutes", { n: Math.max(1, mins) })
          : l.t("from_time", { time: whenText(ctx, status.next_change) });
    }
    let next = status?.next_change
      ? plan.profiles.find((p) => p.id === status.next_profile)
      : undefined;
    if (status?.manual_since && status.manual_until && status.manual_until !== status.next_change) {
      next = current; // a resume point / manual window ends before the next block
    }
    const nextValue = next ? valueLabel(ctx, next) || next.name : "";
    const nextColor = next && next.id !== plan.default_profile ? profileColor(plan, next) : "";
    const segs = this.segments
      .map((seg) => ({
        from: Math.max(0, minutesFromToday(seg.start, tz)),
        to: Math.min(MINUTES_PER_DAY, minutesFromToday(seg.end, tz)),
        profile: seg.profile,
      }))
      .filter((seg) => seg.to > seg.from && seg.profile !== plan.default_profile);
    const manual = manualSegment(ctx, plan, 0);
    const pct = (m: number) => (m / MINUTES_PER_DAY) * 100;
    return html`<div
      class="tl-plan"
      role="button"
      tabindex="0"
      aria-label=${l.t("open_plan", { name: plan.name })}
      style=${!isDefault && plan.enabled ? `border-color:${tint(color, 45)}` : ""}
      @click=${this._open}
      @keydown=${(ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this._open();
        }
      }}
    >
      <div class="tl-row">
        <span class="tl-icon" style="background:${tint(color, 18)};color:${color}">
          <ha-icon .icon=${current?.icon || plan.icon || "mdi:calendar-clock"}></ha-icon>
        </span>
        <span class="tl-text">
          <span class="tl-name">${plan.name}</span>
          <span class="tl-sub" style=${isDefault || status?.manual_since ? "" : `color:${color}`}
            >${sub}</span
          >
        </span>
        ${
          when
            ? html`<span class="tl-next">
                <span class="tl-when">${when}</span>
                <span class="tl-value" style=${nextColor ? `color:${nextColor}` : ""}
                  >${nextValue}</span
                >
              </span>`
            : nothing
        }
        ${resumeButton(l, plan, this._resume, true)}
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
        ${resumeMarks(l, plan.week.day_types.find((d) => d.id === status?.day_type)?.resume_points)}
        <span class="band-now" aria-hidden="true"></span>
      </div>
    </div>`;
  }

  static styles = [
    tokens,
    displayStyles,
    css`
      :host {
        display: block;
      }
      .tl-plan {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px 14px;
        border-radius: 26px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        cursor: pointer;
        transition: background 0.15s;
      }
      .tl-plan:hover {
        background: var(--zw-surface-2);
      }
      .tl-plan:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
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
      .hatch {
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
