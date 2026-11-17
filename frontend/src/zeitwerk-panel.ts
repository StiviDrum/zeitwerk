/**
 * Zeitwerk sidebar panel (custom panel `zeitwerk-panel`, SPEC §10).
 *
 * HA sets `hass`, `narrow`, `route` ({prefix, path}) and `panel`. The state is
 * reconstructable from the route and the backend, so the element can be torn
 * down and recreated at any time.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { NowClock } from "./clock";
import { ZeitwerkConditionsEditor } from "./conditions-editor";
import { applyDayPlan, weekToDays, weekToResume, type DayKey, type DayResume } from "./day-plan";
import { ZeitwerkDayEditor, type DaySaveDetail } from "./day-editor";
import { syncDark } from "./display-ui";
import { localizer, type Localizer } from "./localize";
import { navigate, navigateTo, parentRoute, parseRoute, routePath, type Route } from "./nav";
import { ZeitwerkOverview } from "./panel-overview";
import { ZeitwerkPlanPage } from "./panel-plan";
import { ZeitwerkPlanHeader } from "./plan-header";
import { ZeitwerkPlanWizard } from "./plan-wizard";
import {
  dayName,
  errorMessage,
  languageOf,
  hassChanged,
  stripStatus,
  timeStepOf,
  valueLabel,
  watchedEntities,
} from "./plan-view";
import { ZeitwerkProfiles } from "./profiles-page";
import { defineElements } from "./register";
import { ZeitwerkRules, type PlanMutator } from "./rules-page";
import { RetrySubscription } from "./subscription";
import { applyPlanEvent, upsert } from "./collection";
import { tokens } from "./styles";
import type { Block, HomeAssistant, Plan, PlanEvent } from "./types";
import { CARD_VERSION } from "./version";
import { ZeitwerkWeekGrid } from "./week-grid";

const NOTICE_MS = 4000;
const UNDO_MS = 10_000;

interface PanelRoute {
  prefix?: string;
  path?: string;
}

export class ZeitwerkPanel extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ type: Boolean, reflect: true }) public narrow = false;
  @property({ attribute: false }) public route?: PanelRoute;
  @property({ attribute: false }) public panel?: unknown;

  @state() private _plans?: Plan[];
  @state() private _planError?: string;
  @state() private _notice?: string;
  @state() private _undo?: { before: Plan; after: string };
  @state() private _saveError: string | null = null;
  @state() private _busy = false;
  /** Day editor input, captured when the day route was entered. */
  @state() private _edit?: { key: string; blocks: Block[]; resume: DayResume };

  private _parsed: Route = { name: "overview" };
  private _parsedFor?: PanelRoute;
  private _planSub?: RetrySubscription<PlanEvent>;
  private _noticeTimer?: number;
  private _undoTimer?: number;
  private _watched?: { plans: unknown; ids: string[] };
  private _clock = new NowClock(
    this,
    () => this.hass?.config?.time_zone,
    ({ dayChanged }) => {
      if (dayChanged) this.requestUpdate();
    },
  );

  // --- Lifecycle ------------------------------------------------------------

  public connectedCallback(): void {
    super.connectedCallback();
    this._clock.start();
    this._subscribe();
    window.addEventListener("location-changed", this._onLocation);
    window.addEventListener("popstate", this._onLocation);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clock.stop();
    this._unsubscribe();
    window.clearTimeout(this._noticeTimer);
    window.clearTimeout(this._undoTimer);
    window.removeEventListener("location-changed", this._onLocation);
    window.removeEventListener("popstate", this._onLocation);
  }

  /** Path below the panel prefix, read from the browser location when possible. */
  private _currentPath(): string {
    const prefix = this.route?.prefix;
    if (prefix) {
      const path = location.pathname;
      if (path === prefix || path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
    }
    return this.route?.path ?? "";
  }

  /** Re-read path and query (HA updates `route` itself, but not for query-only changes). */
  private _reparse(): void {
    const next = parseRoute(this._currentPath(), location.search);
    if (JSON.stringify(next) !== JSON.stringify(this._parsed)) {
      this._parsed = next;
      this.requestUpdate();
    }
  }

  private _onLocation = (): void => this._reparse();

  protected shouldUpdate(changed: PropertyValues): boolean {
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const old = changed.get("hass") as HomeAssistant | undefined;
    if (!old || !this.hass) return true;
    const plans = this._plans;
    let watched = this._watched;
    if (!watched || watched.plans !== plans) {
      watched = {
        plans,
        ids: [...new Set((plans ?? []).flatMap((p) => watchedEntities(p)))],
      };
      this._watched = watched;
    }
    return hassChanged(old, this.hass, watched.ids);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass) {
      syncDark(this, this.hass);
      if (!this._planSub && this.isConnected) this._subscribe();
    }
    if (changed.has("route") || this._parsedFor === undefined) {
      this._parsedFor = this.route ?? {};
      this._parsed = parseRoute(this._currentPath(), location.search);
    }
    this._syncEdit();
  }

  protected updated(): void {
    this._clock.update();
  }

  // --- Data -----------------------------------------------------------------

  private _subscribe(): void {
    if (!this.hass?.connection) return;
    this._planSub ??= new RetrySubscription<PlanEvent>({
      hass: () => this.hass,
      msg: { type: "zeitwerk/plans/subscribe" },
      onEvent: (msg) => (this._plans = applyPlanEvent(this._plans ?? [], msg)),
      onError: (err) => (this._planError = err ? errorMessage(err) : undefined),
    });
    this._planSub.start();
  }

  private _unsubscribe(): void {
    this._planSub?.stop();
    this._planSub = undefined;
    this._plans = undefined;
  }

  private _retry = (): void => {
    this._planSub?.retryNow();
  };

  /** Show a plan returned by a create/duplicate call before the subscription delivers it. */
  private _adoptPlan(plan: Plan | undefined): void {
    if (plan?.id) this._plans = upsert(this._plans ?? [], plan);
  }

  private get _l(): Localizer {
    return localizer(languageOf(this.hass));
  }

  private _plan(id: string): Plan | undefined {
    return this._plans?.find((p) => p.id === id);
  }

  /** Capture the day editor input once per visit of a day route. */
  private _syncEdit(): void {
    const route = this._parsed;
    if (route.name !== "day") {
      if (this._edit) this._edit = undefined;
      return;
    }
    const key = `${route.planId}/${route.day}`;
    if (this._edit?.key === key) return;
    const plan = this._plan(route.planId);
    if (!plan) return;
    this._saveError = null;
    this._busy = false;
    this._edit = {
      key,
      blocks: weekToDays(plan)[route.day],
      resume: weekToResume(plan)[route.day],
    };
  }

  private async _updatePlan(plan: Plan, mutate: PlanMutator): Promise<void> {
    if (!this.hass) return;
    const before = stripStatus(plan);
    const next = structuredClone(before);
    mutate(next);
    const saved = await this.hass.callWS<Plan>({
      type: "zeitwerk/plans/update",
      plan_id: next.id,
      plan: next,
    });
    this._offerUndo(before, saved);
  }

  private _offerUndo(before: Plan, after: Plan | undefined | null): void {
    if (!after) return;
    window.clearTimeout(this._undoTimer);
    this._notice = undefined;
    this._undo = { before, after: JSON.stringify(stripStatus(after)) };
    this._undoTimer = window.setTimeout(() => (this._undo = undefined), UNDO_MS);
  }

  private _doUndo = async (): Promise<void> => {
    const undo = this._undo;
    window.clearTimeout(this._undoTimer);
    this._undo = undefined;
    const current = undo ? this._plan(undo.before.id) : undefined;
    if (!undo || !this.hass) return;
    const l = this._l;
    if (!current || JSON.stringify(stripStatus(current)) !== undo.after) {
      this._notify(l.t("undo_conflict"));
      return;
    }
    try {
      await this.hass.callWS({
        type: "zeitwerk/plans/update",
        plan_id: undo.before.id,
        plan: undo.before,
      });
      this._notify(l.t("undone"));
    } catch (err) {
      this._notify(l.t("save_failed", { error: errorMessage(err) }));
    }
  };

  private _notify(text: string, ms = NOTICE_MS): void {
    this._notice = text;
    window.clearTimeout(this._noticeTimer);
    this._noticeTimer = window.setTimeout(() => (this._notice = undefined), ms);
  }

  private _onNotice = (ev: CustomEvent<string>): void => {
    ev.stopPropagation();
    this._notify(ev.detail);
  };

  // --- Header ---------------------------------------------------------------

  private _toggleMenu = (): void => {
    this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
  };

  /** Toolbar back arrow: editors with unsaved changes get to ask first. */
  private _back = (): void => {
    const route = this._parsed;
    const selector =
      route.name === "day"
        ? "zeitwerk-day-editor"
        : route.name === "profiles"
          ? "zeitwerk-profiles"
          : route.name === "rules"
            ? "zeitwerk-rules"
            : route.name === "new"
              ? "zeitwerk-plan-wizard"
              : undefined;
    const editor = selector
      ? this.renderRoot.querySelector<
          HTMLElement & { requestClose?(): void; requestBack?(): void }
        >(selector)
      : null;
    if (editor?.requestClose) return editor.requestClose();
    if (editor?.requestBack) return editor.requestBack();
    const parent = parentRoute(route);
    if (parent) navigateTo(parent);
  };

  private _title(route: Route): string {
    const l = this._l;
    switch (route.name) {
      case "overview":
        return l.t("panel_title");
      case "plan":
        return this._plan(route.planId)?.name ?? l.t("panel_title");
      case "day":
        return dayName(l, route.day);
      case "rules":
        return l.t("config_title");
      case "profiles":
        return l.t("section_profiles");
      case "new":
        return l.t("new_plan_title");
    }
  }

  private _renderToolbar(route: Route) {
    const l = this._l;
    const sub = parentRoute(route) !== null;
    let lead;
    if (sub) {
      lead = html`<button class="icon-btn" aria-label=${l.t("back")} @click=${this._back}>
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>`;
    } else if (customElements.get("ha-menu-button")) {
      lead = html`<ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>`;
    } else if (this.narrow) {
      lead = html`<button class="icon-btn" aria-label=${l.t("menu")} @click=${this._toggleMenu}>
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>`;
    } else {
      lead = nothing;
    }
    return html`<header class="toolbar">
      ${lead}
      <h1>${this._title(route)}</h1>
    </header>`;
  }

  // --- Pages ----------------------------------------------------------------

  private _message(text: string, error = false, withBack = true, retry = false) {
    const l = this._l;
    return html`<div class="message ${error ? "error" : ""}" role=${error ? "alert" : nothing}>
      <span>${text}</span>
      ${
        retry
          ? html`<button class="textbtn retry" @click=${this._retry}>${l.t("retry")}</button>`
          : nothing
      }
      ${
        withBack && this._parsed.name !== "overview"
          ? html`<button class="textbtn" @click=${() => navigateTo({ name: "overview" })}>
              ${l.t("back_to_overview")}
            </button>`
          : nothing
      }
    </div>`;
  }

  private _renderBody(route: Route) {
    const l = this._l;
    if (this.hass && this.hass.user && this.hass.user.is_admin === false) {
      return this._message(l.t("panel_admin_only"), true, false);
    }
    const error = this._planError;
    if (error) return this._message(l.t("not_loaded", { error }), true, false, true);
    if (!this.hass || this._plans === undefined) {
      return this._message(l.t("loading"), false, false);
    }
    const plans = this._plans;
    switch (route.name) {
      case "overview":
        return html`<zeitwerk-overview
          .hass=${this.hass}
          .plans=${plans}
          .localize=${l}
        ></zeitwerk-overview>`;
      case "new": {
        return html`<div class="card">
          <zeitwerk-plan-wizard
            ?dark=${!!this.hass.themes?.darkMode}
            .hass=${this.hass}
            .localize=${l}
            .presetId=${route.preset}
            .hideHead=${true}
            @zw-cancel=${() => navigateTo({ name: "overview" })}
            @zw-created=${(ev: CustomEvent<{ id: string; name: string; plan?: Plan }>) => {
              this._adoptPlan(ev.detail.plan);
              navigateTo({ name: "plan", planId: ev.detail.id }, true);
              this._notify(l.t("created_panel", { name: ev.detail.name }));
            }}
          ></zeitwerk-plan-wizard>
        </div>`;
      }
      default:
    }
    const plan = this._plan(route.planId);
    if (!plan) return this._message(l.t("plan_missing", { plan: route.planId }), true);
    switch (route.name) {
      case "plan":
        return html`<zeitwerk-plan-page
          .hass=${this.hass}
          .plan=${plan}
          .localize=${l}
        ></zeitwerk-plan-page>`;
      case "day":
        return this._renderDay(plan, route.day);
      case "rules":
        return html`<div class="card">
          <zeitwerk-rules
            ?dark=${!!this.hass.themes?.darkMode}
            .hass=${this.hass}
            .plan=${plan}
            .localize=${l}
            .save=${(m: PlanMutator) => this._updatePlan(plan, m)}
            .duplicate=${(name: string) => this._duplicate(plan, name)}
            .deletePlan=${() => this._removePlan(plan)}
            .hideHead=${true}
            @zw-back=${() => navigateTo({ name: "plan", planId: plan.id })}
          ></zeitwerk-rules>
        </div>`;
      case "profiles":
        return html`<div class="card">
          <zeitwerk-profiles
            ?dark=${!!this.hass.themes?.darkMode}
            .hass=${this.hass}
            .plan=${plan}
            .localize=${l}
            .save=${(m: PlanMutator) => this._updatePlan(plan, m)}
            .hideHead=${true}
            @zw-back=${() => navigateTo({ name: "plan", planId: plan.id })}
          ></zeitwerk-profiles>
        </div>`;
    }
  }

  private _renderDay(plan: Plan, day: DayKey) {
    const l = this._l;
    const edit = this._edit;
    if (!edit || edit.key !== `${plan.id}/${day}`) return nothing;
    const labels: Record<string, string> = {};
    const ctx = { hass: this.hass, l };
    for (const p of plan.profiles) labels[p.id] = valueLabel(ctx, p);
    return html`<div class="card">
      <zeitwerk-day-editor
        ?dark=${!!this.hass?.themes?.darkMode}
        .plan=${plan}
        .day=${day}
        .initial=${edit.blocks}
        .initialResume=${edit.resume}
        .localize=${l}
        .valueLabels=${labels}
        .withHoliday=${plan.holidays.mode === "own_day_type" && !!plan.holidays.day_type}
        .step=${timeStepOf(plan)}
        .error=${this._saveError}
        .busy=${this._busy}
        .hideHead=${true}
        @zw-close=${() => navigateTo({ name: "plan", planId: plan.id })}
        @zw-save-day=${(ev: CustomEvent<DaySaveDetail>) => this._saveDay(plan, ev.detail)}
      ></zeitwerk-day-editor>
    </div>`;
  }

  private async _saveDay(plan: Plan, detail: DaySaveDetail): Promise<void> {
    const { blocks, targets, resume } = detail;
    const l = this._l;
    this._busy = true;
    this._saveError = null;
    try {
      await this._updatePlan(plan, (p) => applyDayPlan(p, targets, blocks, l, resume));
      navigateTo({ name: "plan", planId: plan.id });
    } catch (err) {
      this._saveError = l.t("save_failed", { error: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  private async _removePlan(plan: Plan): Promise<void> {
    if (!this.hass) return;
    await this.hass.callWS({ type: "zeitwerk/plans/delete", plan_id: plan.id });
    navigate(routePath({ name: "overview" }), true);
  }

  private async _duplicate(plan: Plan, name: string): Promise<void> {
    if (!this.hass) return;
    const copy = await this.hass.callWS<Plan>({
      type: "zeitwerk/plans/duplicate",
      plan_id: plan.id,
      name,
    });
    this._adoptPlan(copy);
    this._notify(this._l.t("duplicated_panel", { name: copy.name }), 12_000);
    navigateTo({ name: "plan", planId: copy.id });
  }

  protected render() {
    const route = this._parsed;
    const l = this._l;
    return html`
      ${this._renderToolbar(route)}
      <main class="content" @zw-notice=${this._onNotice}>${this._renderBody(route)}</main>
      ${
        this._undo
          ? html`<div class="toast undo" role="status">
              <span>${l.t("saved")}</span>
              <button class="undo-btn" @click=${this._doUndo}>${l.t("undo")}</button>
            </div>`
          : this._notice
            ? html`<div class="toast" role="status">${this._notice}</div>`
            : nothing
      }
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        min-height: 100%;
        box-sizing: border-box;
        background: var(--primary-background-color, #0b0b0d);
        color: var(--zw-text);
        --zw-bg: var(--ha-card-background, var(--card-background-color, #151518));
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 4px;
        height: var(--header-height, 56px);
        padding: 0 8px 0 4px;
        box-sizing: border-box;
        background: var(--app-header-background-color, var(--zw-bg));
        color: var(--app-header-text-color, var(--zw-text));
        border-bottom: 1px solid var(--zw-border);
        padding-top: env(safe-area-inset-top);
      }
      h1 {
        flex: 1;
        min-width: 0;
        margin: 0 0 0 8px;
        font-size: 20px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .icon-btn {
        width: 48px;
        height: 48px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 24px;
        background: none;
        color: inherit;
        cursor: pointer;
      }
      .icon-btn:hover {
        background: var(--zw-surface);
      }
      button:focus-visible {
        outline: 2px solid var(--zw-accent);
        outline-offset: 2px;
      }
      .content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 720px;
        margin: 0 auto;
        padding: 16px 16px 96px;
        box-sizing: border-box;
      }
      :host([narrow]) .content {
        padding: 10px 10px 96px;
      }
      .card {
        padding: 12px;
        border-radius: var(--zw-radius-card);
        background: var(--zw-bg);
        border: 1px solid var(--zw-border);
      }
      .message {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 14px 16px;
        border-radius: 18px;
        background: var(--zw-surface);
        font-size: 14px;
        color: var(--zw-text-2);
      }
      .message.error {
        color: var(--zw-danger);
      }
      .textbtn {
        border: 0;
        background: none;
        padding: 8px 0;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        color: var(--zw-text);
        text-decoration: underline;
        text-underline-offset: 3px;
        cursor: pointer;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: calc(16px + env(safe-area-inset-bottom));
        transform: translateX(-50%);
        max-width: calc(100% - 24px);
        box-sizing: border-box;
        font-size: 13px;
        padding: 10px 16px;
        border-radius: 22px;
        background: var(--zw-bg);
        border: 1px solid var(--zw-border);
        color: var(--zw-text);
        z-index: 5;
      }
      .toast.undo {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 4px 4px 4px 16px;
      }
      .undo-btn {
        min-height: 36px;
        padding: 0 14px;
        border: 0;
        border-radius: 18px;
        background: var(--zw-surface-2);
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        color: var(--zw-text);
        cursor: pointer;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "zeitwerk-panel": ZeitwerkPanel;
  }
}

defineElements([
  ["zeitwerk-plan-header", ZeitwerkPlanHeader],
  ["zeitwerk-week-grid", ZeitwerkWeekGrid],
  ["zeitwerk-overview", ZeitwerkOverview],
  ["zeitwerk-plan-page", ZeitwerkPlanPage],
  ["zeitwerk-day-editor", ZeitwerkDayEditor],
  ["zeitwerk-conditions-editor", ZeitwerkConditionsEditor],
  ["zeitwerk-rules", ZeitwerkRules],
  ["zeitwerk-profiles", ZeitwerkProfiles],
  ["zeitwerk-plan-wizard", ZeitwerkPlanWizard],
  ["zeitwerk-panel", ZeitwerkPanel],
]);

console.info(`%c ZEITWERK-PANEL %c ${CARD_VERSION} `, "background:#ff8b4a;color:#1b0f07", "");
