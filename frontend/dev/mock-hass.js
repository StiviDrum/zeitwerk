// Mocked Home Assistant for dev/preview.html: one plan (SPEC §9 living room),
// a fake websocket subscription and the services/commands the card uses.
const params = new URLSearchParams(location.search);
// panel.html sets this: load zeitwerk-panel (route from ?path=, e.g. /plan/wohnzimmer_heizung/day/mon)
const panelMode = window.__zwPanel === true;
const light = params.get("theme") === "light";
if (light) document.documentElement.classList.add("light");

// Minimal stand-ins for HA's own elements.
customElements.define("ha-card", class extends HTMLElement {});
customElements.define(
  "ha-icon",
  class extends HTMLElement {
    set icon(v) {
      this.setAttribute("icon", v);
    }
    connectedCallback() {
      this.style.cssText =
        "display:inline-block;width:var(--mdc-icon-size,20px);height:var(--mdc-icon-size,20px);border-radius:50%;border:2px solid currentColor;box-sizing:border-box";
    }
  },
);

const setValue = (room, value) => [
  {
    action: "input_number.set_value",
    target: { entity_id: `input_number.temperaturspeicher_${room}` },
    data: { value },
  },
];

const profiles = (room) => [
  { id: "comfort", name: "Komfort", color: "#ff8b4a", icon: "mdi:sun-thermometer-outline", actions: setValue(room, 22) },
  { id: "eco", name: "Absenkung", color: "#6fa8ff", icon: "mdi:weather-night", actions: setValue(room, 18) },
  { id: "away", name: "Abwesend", color: "#aeaeb8", icon: "mdi:home-export-outline", actions: setValue(room, 16) },
];

let plan = {
  id: "wohnzimmer_heizung",
  name: "Heizung Wohnzimmer",
  enabled: true,
  icon: "mdi:radiator",
  tags: ["heizung"],
  profiles: profiles("wohnzimmer"),
  default_profile: "eco",
  activation: {
    match: "all",
    conditions: [{ condition: "state", entity_id: "input_boolean.heizperiode", state: "on" }],
    when_inactive: "none",
    reevaluate: true,
  },
  holidays: { source: "calendar.deutschland_he", mode: "like_day", like_day: "sun", day_type: null },
  week: {
    day_types: [
      {
        id: "workday",
        name: "Werktag",
        days: ["mon", "tue", "wed", "thu", "fri"],
        blocks: [{ start: "16:00", end: "22:00", profile: "comfort" }],
        resume_points: ["13:00"],
      },
      {
        id: "weekend",
        name: "Wochenende",
        days: ["sat", "sun"],
        blocks: [{ start: "09:00", end: "22:00", profile: "comfort" }],
      },
    ],
  },
  overrides: [
    {
      id: "vacation",
      name: "Urlaub",
      profile: "away",
      match: "all",
      conditions: [{ condition: "state", entity_id: "input_boolean.urlaub", state: "on" }],
    },
    {
      id: "nobody_home",
      name: "Niemand zu Hause",
      profile: "away",
      match: "all",
      conditions: [
        { condition: "state", entity_id: "input_boolean.person_1_home", state: "off" },
        { condition: "state", entity_id: "input_boolean.person_2_home", state: "off" },
      ],
    },
  ],
  options: { reapply_on_start: true, reapply_on_profile_change: true, manual_override: "until_next" },
};

const today = (new Date().getDay() + 6) % 7;
let manual = params.get("manual") === "1";
// ?far=1: next change ~2.5 days ahead (weekday shown)
const nextIn = (params.get("far") === "1" ? 3600 : 47) * 60_000;
const status = () => {
  const actResults = plan.activation.conditions.map((c) => states[c.entity_id]?.state === c.state);
  const active = plan.activation.match === "any" ? actResults.some(Boolean) : actResults.every(Boolean);
  const ovResults = Object.fromEntries(
    plan.overrides.map((o) => {
      const r = o.conditions.map((c) => states[c.entity_id]?.state === c.state);
      return [o.id, r.length > 0 && (o.match === "any" ? r.some(Boolean) : r.every(Boolean))];
    }),
  );
  const ov = plan.overrides.find((o) => ovResults[o.id]);
  return {
    profile: !active ? null : ov ? ov.profile : "eco",
    source: !active ? "inactive" : ov ? `override:${ov.id}` : "default",
    day_type: today < 5 ? "workday" : "weekend",
    is_holiday: false,
    active,
    activation_results: actResults,
    override_results: ovResults,
    next_change: ov || !active ? null : new Date(Date.now() + nextIn).toISOString(),
    next_profile: ov || !active ? null : "comfort",
    forced_until: null,
    manual_since: manual ? new Date(Date.now() - 50 * 60_000).toISOString() : null,
    manual_until: manual ? new Date(Date.now() + nextIn).toISOString() : null,
    manual_entity: manual ? "input_number.temperaturspeicher_wohnzimmer" : null,
    manual_attribute: null,
    error: null,
  };
};

// Second plan (panel overview only): switched off, no status details.
const bath = {
  ...structuredClone(plan),
  id: "bad_heizung",
  name: "Heizung Bad",
  enabled: false,
  icon: "mdi:shower",
  profiles: profiles("bad"),
};
if (panelMode) {
  plan.room = "wohnzimmer";
  plan.room_reactions = { window: "away" };
  bath.room = "bad";
}
const garden = { ...structuredClone(bath), id: "garten", name: "Bewaesserung", icon: "mdi:sprinkler", enabled: true, room: undefined };
const quiet = (extra) => ({ profile: "eco", source: "default", day_type: null, is_holiday: false, active: true, next_change: null, next_profile: null, forced_until: null, error: null, ...extra });
const others = { [bath.id]: bath, [garden.id]: garden };
const otherStatus = (p) => (p.enabled ? quiet({}) : quiet({ profile: null, source: "disabled", active: false }));
const allPlans = () => [
  { ...plan, status: status() },
  ...(panelMode ? Object.values(others).map((p) => ({ ...p, status: otherStatus(p) })) : []),
];

// Rooms (panel only): two floors, one open window, one unavailable contact.
const rooms = {
  wohnzimmer: { id: "wohnzimmer", name: "Wohnzimmer", area_id: "wohnzimmer", icon: null, windows: { entities: ["binary_sensor.fenster_wz_links", "binary_sensor.fenster_wz_rechts"], open_delay: 60, close_delay: 0 }, sensors: { temperature: "sensor.wz_temperatur", humidity: "sensor.wz_feuchte" } },
  schlafzimmer: { id: "schlafzimmer", name: "Schlafzimmer", area_id: "schlafzimmer", icon: "mdi:bed", windows: { entities: ["binary_sensor.fenster_sz"], open_delay: 60, close_delay: 0 }, sensors: { temperature: null, humidity: null } },
  bad: { id: "bad", name: "Bad", area_id: "bad", icon: null, windows: { entities: ["binary_sensor.fenster_bad"], open_delay: 30, close_delay: 0 }, sensors: { temperature: null, humidity: null } },
};
const roomPayload = (r) => {
  const st = (id) => states[id]?.state;
  const unavailable = r.windows.entities.filter((id) => ["unavailable", "unknown", undefined].includes(st(id)));
  return {
    ...r,
    window: r.windows.entities.length
      ? { open: r.windows.entities.some((id) => ["on", "open"].includes(st(id))), open_since: null, entities: Object.fromEntries(r.windows.entities.map((id) => [id, st(id)])), unavailable }
      : null,
    area_missing: !!r.area_id && !hass.areas[r.area_id],
    plans: allPlans().filter((p) => p.room === r.id).map((p) => p.id),
  };
};
const roomSubscribers = new Set();
const emitRoom = (event, id) => {
  for (const cb of roomSubscribers) cb({ event, room_id: id, room: event === "removed" ? null : roomPayload(rooms[id]) });
};

const subscribers = new Set();
const emit = () => {
  for (const cb of subscribers) cb({ event: "updated", plan_id: plan.id, plan: { ...plan, status: status() } });
};

const states = {
  "switch.zeitwerk_wohnzimmer_heizung": { entity_id: "switch.zeitwerk_wohnzimmer_heizung", state: "on", attributes: {} },
  "calendar.deutschland_he": {
    entity_id: "calendar.deutschland_he",
    state: "off",
    attributes: { friendly_name: "Feiertage Hessen" },
  },
  "binary_sensor.workday_sensor": {
    entity_id: "binary_sensor.workday_sensor",
    state: "on",
    attributes: { friendly_name: "Arbeitstag", workdays: ["mon", "tue", "wed", "thu", "fri"] },
  },
  "light.flur": { entity_id: "light.flur", state: "off", attributes: { friendly_name: "Flur" } },
  "light.kueche": { entity_id: "light.kueche", state: "off", attributes: { friendly_name: "Küche" } },
  "input_boolean.urlaub": { entity_id: "input_boolean.urlaub", state: params.get("urlaub") === "1" ? "on" : "off", attributes: { friendly_name: "Urlaub" } },
  "input_boolean.heizperiode": {
    entity_id: "input_boolean.heizperiode",
    state: "on",
    attributes: { friendly_name: "Heizperiode" },
  },
  "input_boolean.person_1_home": {
    entity_id: "input_boolean.person_1_home",
    state: "on",
    attributes: { friendly_name: "Person 1 zu Hause" },
  },
  "input_boolean.person_2_home": {
    entity_id: "input_boolean.person_2_home",
    state: "on",
    attributes: { friendly_name: "Person 2 zu Hause" },
  },
  "input_number.temperaturspeicher_wohnzimmer": {
    entity_id: "input_number.temperaturspeicher_wohnzimmer",
    state: "18",
    attributes: { friendly_name: "Temperatur Wohnzimmer", min: 12, max: 26, step: 0.5, unit_of_measurement: "°C" },
  },
};

Object.assign(states, {
  "binary_sensor.fenster_wz_links": { entity_id: "binary_sensor.fenster_wz_links", state: "on", attributes: { friendly_name: "Fenster WZ links", device_class: "window" } },
  "binary_sensor.fenster_wz_rechts": { entity_id: "binary_sensor.fenster_wz_rechts", state: "off", attributes: { friendly_name: "Fenster WZ rechts", device_class: "window" } },
  "binary_sensor.fenster_sz": { entity_id: "binary_sensor.fenster_sz", state: "unavailable", attributes: { friendly_name: "Fenster SZ", device_class: "window" } },
  "binary_sensor.fenster_bad": { entity_id: "binary_sensor.fenster_bad", state: "off", attributes: { friendly_name: "Fenster Bad", device_class: "window" } },
  "binary_sensor.tuer_bad": { entity_id: "binary_sensor.tuer_bad", state: "off", attributes: { friendly_name: "Tuer Bad", device_class: "door" } },
  "sensor.wz_temperatur": { entity_id: "sensor.wz_temperatur", state: "21.3", attributes: { friendly_name: "WZ Temperatur", device_class: "temperature", unit_of_measurement: "°C" } },
  "sensor.wz_feuchte": { entity_id: "sensor.wz_feuchte", state: "48", attributes: { friendly_name: "WZ Feuchte", device_class: "humidity", unit_of_measurement: "%" } },
  "sensor.bad_temperatur": { entity_id: "sensor.bad_temperatur", state: "23.1", attributes: { friendly_name: "Bad Temperatur", device_class: "temperature", unit_of_measurement: "°C" } },
});

const log = (...args) => console.log("[mock-hass]", ...args);
window.mockCalls = [];

// Manually changed value differs from the scheduled one.
if (manual) states["input_number.temperaturspeicher_wohnzimmer"].state = "21.5";

const hass = {
  states,
  areas: {
    wohnzimmer: { area_id: "wohnzimmer", name: "Wohnzimmer", floor_id: "eg", icon: "mdi:sofa" },
    schlafzimmer: { area_id: "schlafzimmer", name: "Schlafzimmer", floor_id: "og" },
    bad: { area_id: "bad", name: "Bad", floor_id: "eg", temperature_entity_id: "sensor.bad_temperatur" },
    keller: { area_id: "keller", name: "Keller", floor_id: null },
  },
  floors: {
    og: { floor_id: "og", name: "Obergeschoss", level: 1 },
    eg: { floor_id: "eg", name: "Erdgeschoss", level: 0 },
  },
  devices: {},
  entities: {
    "binary_sensor.fenster_bad": { entity_id: "binary_sensor.fenster_bad", area_id: "bad" },
    "binary_sensor.tuer_bad": { entity_id: "binary_sensor.tuer_bad", area_id: "bad" },
    "sensor.bad_temperatur": { entity_id: "sensor.bad_temperatur", area_id: "bad" },
  },
  language: params.get("lang") || "de",
  locale: { language: params.get("lang") || "de" },
  config: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, unit_system: { temperature: "°C" } },
  themes: { darkMode: !light },
  formatEntityState: (entity, state) => {
    const s = state ?? entity.state;
    return s === "on" ? "An" : s === "off" ? "Aus" : s;
  },
  user: { is_admin: params.get("admin") !== "0" },
  connection: {
    async subscribeMessage(cb, msg) {
      log("subscribe", msg);
      window.mockSubscribeCalls = (window.mockSubscribeCalls ?? 0) + 1;
      if (params.get("fail") === "1" && window.mockSubscribeCalls <= 2) throw { code: "unknown_error", message: "mock: not ready" };
      if (msg.type === "zeitwerk/rooms/subscribe") {
        roomSubscribers.add(cb);
        setTimeout(() => cb({ event: "init", rooms: Object.values(rooms).map(roomPayload) }), 50);
        return () => roomSubscribers.delete(cb);
      }
      if (msg.plan_id && msg.plan_id !== plan.id) throw { code: "not_found", message: `Plan '${msg.plan_id}' not found` };
      subscribers.add(cb);
      setTimeout(() => cb({ event: "init", plans: allPlans() }), 50);
      return () => subscribers.delete(cb);
    },
  },
  async callWS(msg) {
    log("callWS", msg);
    window.mockCalls.push(msg);
    if (msg.type === "zeitwerk/plans/list") return { plans: [{ ...plan, status: status() }] };
    if (msg.type === "zeitwerk/plans/create") {
      const id = msg.plan.id || msg.plan.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      return { ...msg.plan, id, enabled: true, tags: msg.plan.tags ?? [], status: null };
    }
    if (msg.type === "zeitwerk/rooms/create") {
      const id = (msg.room.id || msg.room.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      rooms[id] = { windows: { entities: [], open_delay: 60, close_delay: 0 }, sensors: { temperature: null, humidity: null }, ...msg.room, id };
      setTimeout(() => emitRoom("added", id), 30);
      return roomPayload(rooms[id]);
    }
    if (msg.type === "zeitwerk/rooms/update") {
      if (!rooms[msg.room_id]) throw { code: "not_found", message: "room" };
      if (msg.room.name === "FAIL") throw { code: "invalid_format", message: "mock: invalid room" };
      rooms[msg.room_id] = { ...msg.room, id: msg.room_id };
      setTimeout(() => emitRoom("updated", msg.room_id), 30);
      return roomPayload(rooms[msg.room_id]);
    }
    if (msg.type === "zeitwerk/rooms/delete") {
      delete rooms[msg.room_id];
      for (const p of [plan, ...Object.values(others)]) if (p.room === msg.room_id) { delete p.room; delete p.room_reactions; }
      setTimeout(() => emitRoom("removed", msg.room_id), 30);
      return null;
    }
    if (msg.type === "zeitwerk/rooms/list") return { rooms: Object.values(rooms).map(roomPayload) };
    if (msg.type === "zeitwerk/preview") {
      const dt = plan.week.day_types.find((d) => d.days.includes(["mon", "tue", "wed", "thu", "fri", "sat", "sun"][today]));
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const at = (hhmm) => {
        const [h, m] = hhmm.split(":").map(Number);
        return new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();
      };
      return {
        plans: {
          [plan.id]: (dt?.blocks ?? []).map((b) => ({ start: at(b.start), end: at(b.end), profile: b.profile })),
        },
      };
    }
    if (msg.type === "zeitwerk/holidays/upcoming") {
      const y = new Date().getFullYear();
      return {
        kind: msg.source.startsWith("calendar.") ? "calendar" : "workday",
        holidays: [
          { date: `${y}-12-25`, name: "1. Weihnachtstag" },
          { date: `${y}-12-26`, name: "2. Weihnachtstag" },
          { date: `${y + 1}-01-01`, name: "Neujahr" },
        ],
      };
    }
    if (msg.type === "zeitwerk/plans/delete") {
      for (const cb of subscribers) cb({ event: "removed", plan_id: plan.id, plan: null });
      return null;
    }
    if (msg.type === "zeitwerk/plans/duplicate") {
      return { ...plan, id: msg.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"), name: msg.name, enabled: false };
    }
    if (msg.type === "zeitwerk/plans/update") {
      if (others[msg.plan_id]) {
        others[msg.plan_id] = structuredClone(msg.plan);
        const p = others[msg.plan_id];
        for (const cb of subscribers) cb({ event: "updated", plan_id: p.id, plan: { ...p, status: otherStatus(p) } });
        for (const id of Object.keys(rooms)) setTimeout(() => emitRoom("updated", id), 30);
        return { ...p, status: otherStatus(p) };
      }
      plan = structuredClone(msg.plan);
      for (const id of Object.keys(rooms)) setTimeout(() => emitRoom("updated", id), 30);
      setTimeout(emit, 30);
      return { ...plan, status: status() };
    }
    throw { code: "unknown_command", message: msg.type };
  },
  async callService(domain, service, data, target) {
    log("callService", domain, service, data, target);
    window.mockCalls.push({ domain, service, data, target });
    if (domain === "zeitwerk" && service === "set_profile_value") {
      const p = plan.profiles.find((x) => x.id === data.profile);
      p.actions[0].data.value = data.value;
      setTimeout(emit, 30);
    }
    if (domain === "zeitwerk" && service === "resume") {
      manual = false;
      setTimeout(emit, 30);
    }
    if (domain === "switch") {
      plan.enabled = service === "turn_on";
      setTimeout(emit, 30);
    }
  },
};

if (panelMode) {
  await import("../../custom_components/zeitwerk/frontend/zeitwerk-panel.js");
  const panel = document.querySelector("zeitwerk-panel");
  const routeOf = () => ({ prefix: "/zeitwerk", path: location.pathname.startsWith("/zeitwerk") ? location.pathname.slice(9) : params.get("path") || "" });
  panel.narrow = params.get("narrow") === "1";
  panel.route = { prefix: "/zeitwerk", path: params.get("path") || "" };
  panel.hass = hass;
  // Like HA's router: location-changed -> new `route` object.
  window.addEventListener("location-changed", () => (panel.route = routeOf()));
  window.addEventListener("popstate", () => (panel.route = routeOf()));
  window.hass = hass;
  window.panel = panel;
} else {
  await import("../../custom_components/zeitwerk/frontend/zeitwerk-card.js");
  const card = document.querySelector("zeitwerk-card");
  card.setConfig(
    params.get("view") === "timeline"
      ? { type: "custom:zeitwerk-card", view: "timeline", tags: params.get("tag") ? [params.get("tag")] : [] }
      : { type: "custom:zeitwerk-card", plan: params.get("plan") || "wohnzimmer_heizung" },
  );
  card.hass = hass;
  window.hass = hass;

  /** Simulate a state change, e.g. setState("input_boolean.urlaub", "on"). */
  window.setState = (entityId, state) => {
    const next = { ...hass, states: { ...hass.states, [entityId]: { ...hass.states[entityId], state } } };
    Object.assign(states, next.states);
    card.hass = next;
    emit();
  };

}
