/** Overview page of the panel: a list of all schedules. */
import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { tint } from "./colors";
import { displayStyles, syncDark } from "./display-ui";
import type { Localizer } from "./localize";
import { linkClick, routePath } from "./nav";
import { overviewRow, type OverviewRow } from "./plan-view";
import { tokens } from "./styles";
import type { HomeAssistant, Plan } from "./types";

export class ZeitwerkOverview extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plans: Plan[] = [];
  @property({ attribute: false }) public localize!: Localizer;

  protected willUpdate(): void {
    syncDark(this, this.hass);
  }

  private _arrow() {
    return html`<svg
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
    </svg>`;
  }

  private _row(row: OverviewRow) {
    const color = row.profile?.color ?? "var(--zw-text-2)";
    const path = routePath({ name: "plan", planId: row.id });
    return html`<a
      class="plan"
      href=${path}
      aria-label=${this.localize.t("open_plan", { name: row.name })}
      @click=${linkClick(path)}
    >
      <span class="icon" style="background:${tint(color, 18)};color:${color}">
        <ha-icon .icon=${row.icon}></ha-icon>
      </span>
      <span class="text">
        <span class="name">${row.name}</span>
        <span class="sub">
          ${
            row.profile
              ? html`<span class="chip" style="background:${tint(color, 18)};color:${color}"
                  ><span class="dot" style="background:${color}"></span>${row.profile.name}${
                    row.profile.value ? ` · ${row.profile.value}` : ""
                  }</span
                >`
              : nothing
          }
          ${
            row.state
              ? html`<span class="state ${row.error ? "bad" : ""}">${row.state}</span>`
              : nothing
          }
          ${
            row.next
              ? html`<span class="next"
                  >${row.next.when} →
                  <span style="color:${row.next.color}">${row.next.label}</span></span
                >`
              : nothing
          }
        </span>
      </span>
      ${this._arrow()}
    </a>`;
  }

  protected render() {
    const l = this.localize;
    const ctx = { hass: this.hass, l };
    const addPlan = routePath({ name: "new" });
    return html`
      <section>
        <div class="separator"><span>${l.t("plans_title")}</span><span class="line"></span></div>
        ${
          this.plans.length
            ? html`<div class="list">${this.plans.map((p) => this._row(overviewRow(ctx, p)))}</div>`
            : html`<div class="placeholder">${l.t("no_plans_panel")}</div>`
        }
        <a class="add" href=${addPlan} @click=${linkClick(addPlan)}>
          <ha-icon .icon=${"mdi:plus"}></ha-icon>${l.t("add_plan")}
        </a>
      </section>
    `;
  }

  static styles = [
    tokens,
    displayStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .separator {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 24px;
        font-size: 15px;
        font-weight: 600;
      }
      .separator .line {
        flex: 1;
        height: 1px;
        background: var(--zw-border);
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .placeholder {
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px dashed var(--zw-border);
        font-size: 13px;
        color: var(--zw-text-2);
      }
      a {
        text-decoration: none;
        color: inherit;
      }
      .plan {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 64px;
        padding: 10px 14px 10px 10px;
        box-sizing: border-box;
        border-radius: 32px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        text-align: left;
        color: var(--zw-text);
        font: inherit;
        -webkit-tap-highlight-color: transparent;
      }
      .plan:hover {
        background: var(--zw-surface-2);
      }
      .plan svg {
        color: var(--zw-text-2);
        flex-shrink: 0;
      }
      .icon {
        width: 44px;
        height: 44px;
        border-radius: 22px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        --mdc-icon-size: 22px;
      }
      .text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .name {
        font-size: 15px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px 10px;
        font-size: 12px;
        color: var(--zw-text-2);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 22px;
        padding: 0 9px;
        border-radius: 11px;
        font-weight: 600;
      }
      .chip .dot {
        width: 7px;
        height: 7px;
        border-radius: 4px;
      }
      .state.bad {
        color: var(--zw-danger);
      }
      .next span {
        font-weight: 600;
      }
      .add {
        text-decoration: none;
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 44px;
        padding: 0 18px 0 12px;
        border-radius: 22px;
        background: var(--zw-accent);
        color: var(--zw-on-accent);
        font: inherit;
        font-size: 14px;
        font-weight: 700;
      }
    `,
  ];
}
