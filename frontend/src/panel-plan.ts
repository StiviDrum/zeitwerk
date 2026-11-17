/** Plan page of the panel: header, profiles, read-only week grid (tap a day to edit), settings link. */
import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import { profileColor } from "./colors";
import { conditionsSummary, type Condition } from "./conditions";
import { displayStyles, syncDark } from "./display-ui";
import type { Localizer } from "./localize";
import { linkClick, navigateTo, routePath } from "./nav";
import { holidaySummary, valueLabel, type ViewCtx } from "./plan-view";
import { tokens } from "./styles";
import type { DayKey } from "./day-plan";
import type { HomeAssistant, Plan } from "./types";

export class ZeitwerkPlanPage extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plan!: Plan;
  @property({ attribute: false }) public localize!: Localizer;

  protected willUpdate(): void {
    syncDark(this, this.hass);
  }

  private _openDay = (ev: CustomEvent<DayKey>): void => {
    navigateTo({ name: "day", planId: this.plan.id, day: ev.detail });
  };

  private _link(icon: string, title: string, lines: string[], path: string) {
    return html`<a class="link" href=${path} @click=${linkClick(path)}>
      <span class="licon"><ha-icon .icon=${icon}></ha-icon></span>
      <span class="ltext">
        <span class="ltitle">${title}</span>
        ${lines.map((line) => html`<span class="lsub">${line}</span>`)}
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

  private _rulesSummary(ctx: ViewCtx, plan: Plan): string[] {
    const l = ctx.l;
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
      ? `${conditionsSummary(act.conditions as Condition[], act.match, ctx.hass, l)} · ${
          plan.status?.active ? l.t("fulfilled") : l.t("not_fulfilled")
        }`
      : l.t("always_runs");
    return [
      `${l.t("rules_overrides")}: ${overrides}`,
      `${l.t("rules_activation")}: ${activation}`,
      `${l.t("rules_holidays")}: ${holidaySummary(ctx, plan)}`,
    ];
  }

  protected render() {
    const plan = this.plan;
    const l = this.localize;
    const ctx: ViewCtx = { hass: this.hass, l };
    return html`
      <zeitwerk-plan-header .hass=${this.hass} .plan=${plan} .localize=${l}></zeitwerk-plan-header>
      <div class="separator"><span>${l.t("section_profiles")}</span><span class="line"></span></div>
      <div class="pchips">
        ${plan.profiles.map((p) => {
          const value = valueLabel(ctx, p);
          return html`<span class="pchip"
            ><span class="swatch" style="background:${profileColor(plan, p)}"></span>${p.name}${
              value ? ` · ${value}` : ""
            }</span
          >`;
        })}
      </div>
      <div class="separator"><span>${l.t("section_week")}</span><span class="line"></span></div>
      <zeitwerk-week-grid
        .hass=${this.hass}
        .plan=${plan}
        .localize=${l}
        interactive
        @zw-day=${this._openDay}
      ></zeitwerk-week-grid>
      ${this._link(
        "mdi:account-cog-outline",
        l.t("edit_profiles"),
        [],
        routePath({ name: "profiles", planId: plan.id }),
      )}
      ${this._link(
        "mdi:tune-variant",
        l.t("config_title"),
        this._rulesSummary(ctx, plan),
        routePath({ name: "rules", planId: plan.id }),
      )}
    `;
  }

  static styles = [
    tokens,
    displayStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
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
      .link {
        text-decoration: none;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 56px;
        padding: 12px 14px 12px 10px;
        box-sizing: border-box;
        text-align: left;
        color: var(--zw-text);
        font: inherit;
        border-radius: 22px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
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
    `,
  ];
}
