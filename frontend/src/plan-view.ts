/**
 * Display logic shared by the card and the panel: value labels, times,
 * manual-override ranges, week grid rows, overview data. Pure functions
 * (no DOM) so they can be unit tested.
 */
import { dayTypeFor, previousWeekday, rowSegments, type Segment } from "./blocks";
import { pauseReason, type Condition } from "./conditions";
import type { DayKey } from "./day-plan";
import type { Localizer } from "./localize";
import { controlFor, formatValue, quickValue, type QuickValue } from "./quickview";
import { MINUTES_PER_DAY, minutesFromToday, zonedNow, zonedWhen } from "./time";
import { WEEKDAYS, type DayType, type HomeAssistant, type Plan, type PlanStatus } from "./types";
import { profileColor } from "./colors";

export interface ViewCtx {
  hass?: HomeAssistant;
  l: Localizer;
}

export interface GridRow {
  key: DayKey;
  label: string;
  dayType: DayType | undefined;
  segments: Segment[];
  today: boolean;
  /** 0 = today's row, 1 = tomorrow's row (manual override hatch). */
  dayOffset: number | null;
}

/** Copy of a plan without its runtime status (what plans/update takes). */
export function stripStatus(plan: Plan): Plan {
  const copy = structuredClone(plan);
  delete copy.status;
  delete copy.room_missing;
  return copy;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

export function languageOf(hass: HomeAssistant | undefined): string | undefined {
  return hass?.locale?.language ?? hass?.language;
}

/** Value of a profile as text ("21 °C", "On"); `pending` = optimistic slider values. */
export function valueLabel(
  ctx: ViewCtx,
  profile: Plan["profiles"][number] | undefined,
  pending: Record<string, number | string> = {},
): string {
  if (!profile) return "";
  const qv = quickValue(profile);
  if (!qv) return "";
  const entity = ctx.hass?.states[qv.entityId];
  const unit = ctx.hass?.config?.unit_system?.temperature ?? "°C";
  const control = controlFor(qv, entity, unit);
  const p = pending[profile.id];
  const shown: QuickValue = p !== undefined && qv.kind === "value" ? { ...qv, value: p } : qv;
  return formatValue(shown, control, ctx.l.lang, [ctx.l.t("on"), ctx.l.t("off")]);
}

/** "05:15" today, otherwise "Mo 05:15". */
export function whenText(ctx: ViewCtx, iso: string): string {
  return zonedWhen(iso, ctx.hass?.config?.time_zone, (i) => ctx.l.weekdayShort(i));
}

/** Current value of the manually changed target (e.g. "21.5 °C"). */
export function manualValue(ctx: ViewCtx, status: PlanStatus): string {
  const hass = ctx.hass;
  const entity = status.manual_entity ? hass?.states[status.manual_entity] : undefined;
  if (!entity) return "";
  const attr = status.manual_attribute;
  if (attr) {
    const raw = entity.attributes?.[attr];
    if (raw === undefined || raw === null) return "";
    return (
      hass?.formatEntityAttributeValue?.(entity, attr) ??
      `${raw}${attr.includes("temp") && hass?.config?.unit_system?.temperature ? ` ${hass.config.unit_system.temperature}` : ""}`
    );
  }
  return hass?.formatEntityState?.(entity) ?? entity.state;
}

/** Hatched range of a manual override within one row (today/tomorrow), in percent. */
export function manualSegment(
  ctx: ViewCtx,
  plan: Plan,
  dayOffset: number,
): { left: number; width: number } | null {
  const status = plan.status;
  if (!status?.manual_since) return null;
  const tz = ctx.hass?.config?.time_zone;
  const dayStart = (iso: string | null | undefined, fallback: number) =>
    iso ? minutesFromToday(iso, tz) : fallback;
  const from = Math.max(dayStart(status.manual_since, 0), dayOffset * MINUTES_PER_DAY);
  const to = Math.min(
    dayStart(status.manual_until, (dayOffset + 1) * MINUTES_PER_DAY),
    (dayOffset + 1) * MINUTES_PER_DAY,
  );
  if (to <= from) return null;
  const base = dayOffset * MINUTES_PER_DAY;
  return {
    left: ((from - base) / MINUTES_PER_DAY) * 100,
    width: ((to - from) / MINUTES_PER_DAY) * 100,
  };
}

export function dayName(l: Localizer, day: DayKey): string {
  return day === "holiday" ? l.t("holiday") : l.weekdayLong(WEEKDAYS.indexOf(day));
}

/** Rows of the week grid: Mo–Su and, with an own holiday day type, a holiday row. */
export function gridRows(ctx: ViewCtx, plan: Plan): GridRow[] {
  const l = ctx.l;
  const now = zonedNow(ctx.hass?.config?.time_zone);
  const rows: GridRow[] = WEEKDAYS.map((wd, i) => {
    const dayType = dayTypeFor(plan, wd);
    const offset = (i - now.weekdayIndex + 7) % 7;
    return {
      key: wd,
      label: l.weekdayShort(i),
      dayType,
      segments: rowSegments(dayType, dayTypeFor(plan, previousWeekday(wd))),
      today: i === now.weekdayIndex && !plan.status?.is_holiday,
      dayOffset: offset <= 1 ? offset : null,
    };
  });
  if (plan.holidays.mode === "own_day_type") {
    const holiday = plan.week.day_types.find((d) => d.id === plan.holidays.day_type);
    if (holiday) {
      rows.push({
        key: "holiday",
        label: l.t("holiday_short"),
        dayType: holiday,
        segments: rowSegments(holiday, undefined),
        today: !!plan.status?.is_holiday,
        dayOffset: null,
      });
    }
  }
  return rows;
}

export function pausedText(ctx: ViewCtx, plan: Plan): string {
  const reason = pauseReason(
    plan.activation.conditions as Condition[],
    plan.status?.activation_results ?? [],
    ctx.hass,
    ctx.l,
  );
  return reason ? ctx.l.t("paused_reason", { reason }) : ctx.l.t("plan_paused");
}

export function holidaySummary(ctx: ViewCtx, plan: Plan): string {
  const l = ctx.l;
  const h = plan.holidays;
  if (h.mode === "off" || !h.source) return l.t("holiday_mode_off");
  const source = String(ctx.hass?.states[h.source]?.attributes.friendly_name ?? h.source);
  if (h.mode === "like_day") {
    return l.t("holiday_summary_like", {
      source,
      day: l.weekdayLong(WEEKDAYS.indexOf(h.like_day ?? "sun")),
    });
  }
  return l.t("holiday_summary_own", { source });
}

/** Whether the plan deviates from its schedule in a way "resume" ends. */
export function canResume(plan: Plan): boolean {
  const s = plan.status;
  return !!(plan.enabled && s && (s.manual_since || s.forced_until));
}

/** One row of the panel overview ("Allgemeine Zeitpläne"). */
export interface OverviewRow {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  error: string | null;
  /** Current profile (name + colour); null when paused/off/unknown. */
  profile: { name: string; color: string; value: string } | null;
  /** Short state text when there is no current profile ("Plan off", "paused"). */
  state: string;
  /** Next change: "from 16:00" and the value/name that applies then. */
  next: { when: string; label: string; color: string } | null;
}

export function overviewRow(ctx: ViewCtx, plan: Plan): OverviewRow {
  const l = ctx.l;
  const status = plan.status;
  const current = plan.profiles.find((p) => p.id === status?.profile);
  const next = status?.next_change
    ? plan.profiles.find((p) => p.id === status.next_profile)
    : undefined;
  let state = "";
  if (status?.error) state = `${l.t("plan_error")}: ${status.error}`;
  else if (!plan.enabled) state = l.t("plan_off");
  else if (!current && status && !status.active) state = pausedText(ctx, plan);
  const showProfile = !!current && plan.enabled;
  return {
    id: plan.id,
    name: plan.name,
    icon: plan.icon || "mdi:calendar-clock",
    enabled: plan.enabled,
    error: status?.error ?? null,
    profile: showProfile
      ? {
          name: current.name,
          color: profileColor(plan, current),
          value: valueLabel(ctx, current),
        }
      : null,
    state,
    next:
      plan.enabled && status?.next_change && next
        ? {
            when: l.t("from_time", { time: whenText(ctx, status.next_change) }),
            label: valueLabel(ctx, next) || next.name,
            color: profileColor(plan, next),
          }
        : null,
  };
}

/**
 * Entities whose state changes matter for rendering a plan (DESIGN.md §3):
 * its switch, the quick-view entities of its profiles and – with
 * `conditions` – the entities used in activation/override conditions.
 */
export function watchedEntities(plan: Plan, conditions = true): string[] {
  const ids = [`switch.zeitwerk_${plan.id}`];
  for (const p of plan.profiles) {
    const qv = quickValue(p);
    if (qv) ids.push(qv.entityId);
  }
  if (conditions) {
    const all = [...plan.activation.conditions, ...plan.overrides.flatMap((o) => o.conditions)];
    for (const c of all) {
      const e = c.entity_id;
      if (typeof e === "string") ids.push(e);
      else if (Array.isArray(e)) ids.push(...e.filter((x): x is string => typeof x === "string"));
    }
  }
  return ids;
}

/** Allowed values of the plan option `options.time_step` (minutes). */
export const TIME_STEPS = [5, 10, 15, 30, 60];

/** The plan's time step (fallback 15). */
export function timeStepOf(plan: Plan): number {
  const n = Number(plan.options?.time_step);
  return TIME_STEPS.includes(n) ? n : 15;
}

/**
 * Whether a `hass` update matters to the panel: language/theme/admin, the
 * area and floor registries (floor grouping, icons) or one of `ids`.
 */
export function hassChanged(old: HomeAssistant, now: HomeAssistant, ids: string[]): boolean {
  return (
    old.language !== now.language ||
    old.locale?.language !== now.locale?.language ||
    old.themes?.darkMode !== now.themes?.darkMode ||
    old.user?.is_admin !== now.user?.is_admin ||
    old.areas !== now.areas ||
    old.floors !== now.floors ||
    ids.some((id) => old.states[id] !== now.states[id])
  );
}
