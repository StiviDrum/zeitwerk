/** Plan header (icon, name, current profile, next change, on/off switch, reason line). */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { profileColor, tint } from "./colors";
import {
  displayStyles,
  fireNotice,
  resumeButton,
  resumePlan,
  syncDark,
  togglePlan,
} from "./display-ui";
import { localizer, type Localizer } from "./localize";
import {
  languageOf,
  manualValue,
  pausedText,
  valueLabel,
  whenText,
  type ViewCtx,
} from "./plan-view";
import { tokens } from "./styles";
import type { HomeAssistant, Plan } from "./types";

export class ZeitwerkPlanHeader extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize?: Localizer;
  /** Optimistic slider values not yet confirmed by the backend. */
  @property({ attribute: false }) public pending: Record<string, number | string> = {};

  private get _ctx(): ViewCtx {
    return { hass: this.hass, l: this.localize ?? localizer(languageOf(this.hass)) };
  }

  protected willUpdate(): void {
    syncDark(this, this.hass);
  }

  private _toggle = async (): Promise<void> => {
    if (!this.hass) return;
    fireNotice(this, await togglePlan(this.hass, this.plan));
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
    const status = plan.status;
    const current = plan.profiles.find((p) => p.id === status?.profile);
    const color = current ? profileColor(plan, current) : "var(--zw-text-2)";
    const value = (id: string | null | undefined) =>
      valueLabel(
        ctx,
        plan.profiles.find((p) => p.id === id),
        this.pending,
      );
    let subline: TemplateResult | string = "";
    if (status?.error) {
      subline = html`<span class="danger">${l.t("plan_error")}: ${status.error}</span>`;
    } else if (!plan.enabled) {
      subline = l.t("plan_off");
    } else if (current) {
      const manual = !!status?.manual_since;
      const val = manual ? manualValue(ctx, status!) : value(current.id);
      const name = manual ? l.t("manual_cap") : current.name;
      const next = plan.profiles.find((p) => p.id === status?.next_profile);
      let nextText = "";
      if (manual && status?.manual_until) {
        // Resume point or end of the manual window may come before the next block.
        const target = status.next_change === status.manual_until ? next : current;
        nextText = ` · ${l.t("until_time", { time: whenText(ctx, status.manual_until) })}${target ? ` → ${value(target.id) || target.name}` : ""}`;
      } else if (status?.next_change && next) {
        nextText = ` · ${l.t("from_time", { time: whenText(ctx, status.next_change) })} → ${value(next.id) || next.name}`;
      }
      subline = html`<span class="current" style="color:${manual ? "var(--zw-text)" : color}"
          >${name}${val ? ` ${val}` : ""}</span
        >${nextText}`;
    } else if (status?.source === "inactive") {
      subline = pausedText(ctx, plan);
    }
    if (status?.source === "inactive" && current) {
      subline = html`${subline} · ${pausedText(ctx, plan)}`;
    }
    return html`<div class="header">
      <div class="icon" style="background:${tint(color, 18)};color:${color}">
        <ha-icon .icon=${plan.icon || "mdi:calendar-clock"}></ha-icon>
      </div>
      <div class="titles">
        <div class="name">${plan.name}</div>
        <div class="sub">${subline}</div>
        ${this._reason(ctx)}
      </div>
      <button
        class="switch"
        role="switch"
        aria-label=${l.t("toggle_plan")}
        aria-checked=${plan.enabled ? "true" : "false"}
        @click=${this._toggle}
      >
        <span></span>
      </button>
    </div>`;
  }

  /**
   * Why the plan deviates from the week plan right now (override, forced
   * profile, manual change, holiday) – one quiet line, shown only when
   * something applies.
   */
  private _reason(ctx: ViewCtx) {
    const { l } = ctx;
    const plan = this.plan;
    const status = plan.status;
    if (!status || !plan.enabled || status.error || !status.active) return nothing;
    const items: { icon: string; text: string; color?: string }[] = [];
    const source = status.source ?? "";
    const profileOf = (id: string | null | undefined) => plan.profiles.find((p) => p.id === id);
    if (source === "room:window") {
      const profile = profileOf(status.profile);
      items.push({
        icon: "mdi:window-open-variant",
        text: l.t("window_open_reason"),
        color: profile ? profileColor(plan, profile) : undefined,
      });
    } else if (status.manual_since) {
      items.push({ icon: "mdi:hand-back-right-outline", text: l.t("manual") });
    } else if (status.forced_until) {
      const forced = profileOf(status.profile);
      items.push({
        icon: "mdi:timer-outline",
        text: l.t("forced_until", {
          profile: forced?.name ?? "",
          time: whenText(ctx, status.forced_until),
        }),
        color: forced ? profileColor(plan, forced) : undefined,
      });
    } else if (source.startsWith("override:")) {
      const ov = plan.overrides.find((o) => o.id === source.slice(9));
      const profile = profileOf(ov?.profile ?? status.profile);
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
      ${resumeButton(l, plan, this._resume)}
    </div>`;
  }

  static styles = [
    tokens,
    displayStyles,
    css`
      :host {
        display: block;
      }
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
        align-items: center;
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
    `,
  ];
}
