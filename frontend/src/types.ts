/** Plan data as sent by the zeitwerk websocket API (see docs/SPEC.md §3). */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface Block {
  start: string;
  end: string;
  profile: string;
}

export interface DayType {
  id: string;
  name: string;
  days: Weekday[];
  blocks: Block[];
}

export interface ProfileAction {
  action?: string;
  service?: string;
  target?: { entity_id?: string | string[] };
  entity_id?: string | string[];
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Profile {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  actions: ProfileAction[];
}

export interface Override {
  id: string;
  name: string;
  profile: string;
  match: "all" | "any";
  conditions: Record<string, unknown>[];
}

export interface PlanStatus {
  profile: string | null;
  source: string | null;
  day_type: string | null;
  is_holiday: boolean;
  active: boolean;
  next_change: string | null;
  next_profile: string | null;
  forced_until: string | null;
  error: string | null;
}

export interface Plan {
  id: string;
  name: string;
  enabled: boolean;
  icon: string | null;
  tags: string[];
  profiles: Profile[];
  default_profile: string;
  activation: {
    match: "all" | "any";
    conditions: Record<string, unknown>[];
    when_inactive: string;
    reevaluate: boolean;
  };
  holidays: {
    source: string | null;
    mode: "off" | "like_day" | "own_day_type";
    like_day: Weekday | null;
    day_type: string | null;
  };
  week: { day_types: DayType[] };
  overrides: Override[];
  options: Record<string, unknown>;
  status?: PlanStatus | null;
}

export interface PlanEvent {
  event: "init" | "added" | "updated" | "removed";
  plans?: Plan[];
  plan_id?: string;
  plan?: Plan | null;
}

export interface ZeitwerkCardConfig {
  type: string;
  view?: "week" | "timeline" | "profiles";
  plan?: string;
  tags?: string[];
  show_profile_sliders?: boolean;
  time_step?: number;
  compact?: boolean;
}

/** The subset of Home Assistant's `hass` object the card uses. */
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassConnection {
  subscribeMessage<T>(
    callback: (msg: T) => void,
    msg: Record<string, unknown>,
  ): Promise<() => Promise<void> | void>;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  locale?: { language: string };
  language?: string;
  config?: { time_zone?: string; unit_system?: { temperature?: string } };
  themes?: { darkMode?: boolean };
  user?: { is_admin?: boolean };
  connection: HassConnection;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
}
