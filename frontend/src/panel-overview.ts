/** Overview page of the panel: rooms (placeholder) and "General schedules". */
import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { tint } from "./colors";
import { displayStyles, syncDark } from "./display-ui";
import type { Localizer } from "./localize";
import { linkClick, routePath } from "./nav";
import { overviewRow, type OverviewRow } from "./plan-view";
import { tokens } from "./styles";
import { floorGroups, hintText, roomClimate, roomHints, roomIcon, windowView } from "./rooms";
import type { HomeAssistant, Plan, Room } from "./types";

export class ZeitwerkOverview extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public plans: Plan[] = [];
  @property({ attribute: false }) public rooms: Room[] = [];
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

  private _hints() {
    const hints = roomHints(this.rooms, this.plans);
    if (!hints.length) return nothing;
    const l = this.localize;
    return html`<section class="hints" role="status">
      ${hints.map((h) => {
        const path =
          h.kind === "plan_room_missing"
            ? routePath({ name: "plan", planId: h.plan })
            : routePath({ name: "room", roomId: h.room });
        return html`<a class="hint" href=${path} @click=${linkClick(path)}
          ><ha-icon .icon=${"mdi:alert-outline"}></ha-icon><span>${hintText(h, l)}</span></a
        >`;
      })}
    </section>`;
  }

  private _tile(room: Room) {
    const l = this.localize;
    const ctx = { hass: this.hass, l };
    const path = routePath({ name: "room", roomId: room.id });
    const win = windowView(room);
    const climate = roomClimate(room, this.hass);
    const rows = room.plans
      .map((id) => this.plans.find((p) => p.id === id))
      .filter((p): p is Plan => !!p)
      .map((p) => overviewRow(ctx, p));
    const winLabel = win.problem
      ? l.t("room_window_problem")
      : win.kind === "open"
        ? l.t("room_window_open")
        : l.t("room_window_closed");
    return html`<a
      class="tile"
      href=${path}
      aria-label=${room.name}
      data-room=${room.id}
      @click=${linkClick(path)}
    >
      <span class="thead">
        <span class="ticon"><ha-icon .icon=${roomIcon(room, this.hass)}></ha-icon></span>
        <span class="ttext">
          <span class="name">${room.name}</span>
          ${
            climate.temperature || climate.humidity
              ? html`<span class="climate"
                  >${[climate.temperature, climate.humidity].filter(Boolean).join(" · ")}</span
                >`
              : nothing
          }
        </span>
        ${
          win.kind !== "none"
            ? html`<span
                class="win ${win.kind} ${win.problem ? "problem" : ""}"
                title=${winLabel}
                aria-label=${winLabel}
                data-window=${win.problem ? "problem" : win.kind}
              >
                <ha-icon
                  .icon=${win.kind === "open" ? "mdi:window-open-variant" : "mdi:window-closed-variant"}
                ></ha-icon>
                ${win.problem ? html`<ha-icon class="warn" .icon=${"mdi:alert-circle"}></ha-icon>` : nothing}
              </span>`
            : nothing
        }
      </span>
      ${
        rows.length
          ? html`<span class="chips">
              ${rows.map((r) => {
                const color = r.profile?.color ?? "var(--zw-text-2)";
                return html`<span class="chip" style="background:${tint(color, 18)};color:${color}"
                  ><span class="dot" style="background:${color}"></span
                  ><span class="cname">${r.name}</span
                  >${r.profile ? html`<span class="cprofile"> · ${r.profile.name}</span>` : nothing}${
                    r.next
                      ? html`<span class="cnext"> · ${r.next.when}</span>`
                      : r.state
                        ? html`<span class="cnext"> · ${r.state}</span>`
                        : nothing
                  }</span
                >`;
              })}
            </span>`
          : nothing
      }
    </a>`;
  }

  protected render() {
    const l = this.localize;
    const ctx = { hass: this.hass, l };
    const groups = floorGroups(this.rooms, this.hass, l.t("other_rooms"));
    const general = this.plans.filter((p) => !p.room || p.room_missing);
    const addRoom = routePath({ name: "room_new" });
    const addPlan = routePath({ name: "new" });
    return html`
      ${this._hints()}
      <section class="rooms" data-slot="rooms">
        <div class="separator"><span>${l.t("rooms")}</span><span class="line"></span></div>
        ${
          groups.length
            ? groups.map(
                (g) =>
                  html`<div class="floor" data-floor=${g.floorId ?? ""}>
                    <div class="floor-name">
                      ${g.icon ? html`<ha-icon .icon=${g.icon}></ha-icon>` : nothing}${g.name}
                    </div>
                    <div class="tiles">${g.rooms.map((r) => this._tile(r))}</div>
                  </div>`,
              )
            : html`<div class="placeholder">${l.t("no_rooms")}</div>`
        }
        <a class="add" href=${addRoom} @click=${linkClick(addRoom)}>
          <ha-icon .icon=${"mdi:plus"}></ha-icon>${l.t("add_room")}
        </a>
      </section>
      <section>
        <div class="separator"><span>${l.t("general_plans")}</span><span class="line"></span></div>
        ${
          general.length
            ? html`<div class="list">${general.map((p) => this._row(overviewRow(ctx, p)))}</div>`
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
      .hints {
        gap: 6px;
      }
      .hint {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 6px 14px;
        box-sizing: border-box;
        border-radius: 22px;
        font-size: 13px;
        background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, transparent);
        color: var(--zw-text);
        --mdc-icon-size: 18px;
      }
      .hint ha-icon {
        color: var(--warning-color, #ffa600);
        flex-shrink: 0;
      }
      .floor {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .floor-name {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text-2);
        --mdc-icon-size: 16px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 8px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px;
        box-sizing: border-box;
        border-radius: 26px;
        background: var(--zw-surface);
        border: 1px solid var(--zw-border);
        -webkit-tap-highlight-color: transparent;
      }
      .tile:hover {
        background: var(--zw-surface-2);
      }
      .thead {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ticon {
        width: 44px;
        height: 44px;
        border-radius: 22px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--zw-surface-2);
        --mdc-icon-size: 22px;
      }
      .ttext {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .climate {
        font-size: 13px;
        color: var(--zw-text-2);
        font-variant-numeric: tabular-nums;
      }
      .win {
        position: relative;
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--zw-surface-2);
        color: var(--zw-text-2);
        --mdc-icon-size: 20px;
      }
      .win.open {
        background: color-mix(in srgb, var(--warning-color, #ffa600) 24%, transparent);
        color: var(--warning-color, #ffa600);
      }
      .win .warn {
        position: absolute;
        right: -3px;
        top: -3px;
        --mdc-icon-size: 16px;
        color: var(--zw-danger);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips .chip {
        height: auto;
        min-height: 24px;
        padding: 2px 10px;
        font-size: 12px;
      }
      .cprofile,
      .cnext {
        font-weight: 500;
        opacity: 0.85;
      }
    `,
  ];
}
