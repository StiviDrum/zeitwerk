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
  /** Wall times (HH:MM) that end a manual change and resume the schedule. */
  resume_points?: string[];
  /** Whether the resume points also end a forced profile. */
  resume_forced?: boolean;
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
  activation_results?: boolean[];
  override_results?: Record<string, boolean>;
  next_change: string | null;
  next_profile: string | null;
  forced_until: string | null;
  manual_since?: string | null;
  manual_until?: string | null;
  manual_entity?: string | null;
  /** Watched attribute of manual_entity (null = its state). */
  manual_attribute?: string | null;
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
  /** Room the plan belongs to (SPEC §10); absent = general schedule. */
  room?: string | null;
  /** Room event -> profile id (`window`: profile while a window is open). */
  room_reactions?: { window?: string | null };
  /** The plan names a room that does not exist (any more). */
  room_missing?: boolean;
  status?: PlanStatus | null;
}

export interface RoomWindowState {
  open: boolean;
  open_since: string | null;
  entities: Record<string, string>;
  /** Window contacts that are unavailable/unknown right now. */
  unavailable: string[];
}

/** Room as sent by `zeitwerk/rooms/*` (SPEC §10). */
export interface Room {
  id: string;
  name: string;
  area_id: string | null;
  icon: string | null;
  windows: { entities: string[]; open_delay: number; close_delay: number };
  sensors: { temperature: string | null; humidity: string | null };
  /** Null while the room has no window tracker (e.g. not started yet). */
  window: RoomWindowState | null;
  area_missing: boolean;
  /** Ids of the plans that belong to the room. */
  plans: string[];
}

export interface RoomEvent {
  event: "init" | "added" | "updated" | "removed";
  rooms?: Room[];
  room_id?: string;
  room?: Room | null;
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
  /** Timeline: plan ids to show (in this order); empty = all. */
  plans?: string[];
  tags?: string[];
  title?: string;
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

/** Registry data HA's frontend puts on `hass` (all optional here). */
export interface HassArea {
  area_id: string;
  name: string;
  floor_id?: string | null;
  icon?: string | null;
  temperature_entity_id?: string | null;
  humidity_entity_id?: string | null;
}

export interface HassFloor {
  floor_id: string;
  name: string;
  level?: number | null;
  icon?: string | null;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  areas?: Record<string, HassArea>;
  floors?: Record<string, HassFloor>;
  devices?: Record<string, { id: string; area_id?: string | null }>;
  entities?: Record<
    string,
    { entity_id: string; device_id?: string | null; area_id?: string | null }
  >;
  locale?: { language: string };
  language?: string;
  config?: { time_zone?: string; unit_system?: { temperature?: string } };
  themes?: { darkMode?: boolean };
  user?: { is_admin?: boolean };
  connection: HassConnection;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  formatEntityState?(entity: HassEntity, state?: string): string;
  formatEntityAttributeValue?(entity: HassEntity, attribute: string, value?: unknown): string;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
}
