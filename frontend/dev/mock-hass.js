// Mocked Home Assistant for dev/preview.html: one plan (SPEC §9 living room),
// a fake websocket subscription and the services/commands the card uses.
const params = new URLSearchParams(location.search);
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
  activation: { match: "all", conditions: [], when_inactive: "none", reevaluate: true },
  holidays: { source: "calendar.deutschland_he", mode: "like_day", like_day: "sun", day_type: null },
  week: {
    day_types: [
      {
        id: "workday",
        name: "Werktag",
        days: ["mon", "tue", "wed", "thu", "fri"],
        blocks: [{ start: "16:00", end: "22:00", profile: "comfort" }],
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
    { id: "vacation", name: "Urlaub", profile: "away", match: "all", conditions: [] },
    { id: "nobody_home", name: "Niemand zu Hause", profile: "away", match: "all", conditions: [] },
  ],
  options: { reapply_on_start: true, reapply_on_profile_change: true, manual_override: "until_next" },
};

const today = (new Date().getDay() + 6) % 7;
const status = () => ({
  profile: "eco",
  source: "schedule",
  day_type: today < 5 ? "workday" : "weekend",
  is_holiday: false,
  active: true,
  activation_results: [],
  override_results: [],
  next_change: new Date(Date.now() + 47 * 60_000).toISOString(),
  next_profile: "comfort",
  forced_until: null,
  error: null,
});

const subscribers = new Set();
const emit = () => {
  for (const cb of subscribers) cb({ event: "updated", plan_id: plan.id, plan: { ...plan, status: status() } });
};

const states = {
  "switch.zeitwerk_wohnzimmer_heizung": { entity_id: "switch.zeitwerk_wohnzimmer_heizung", state: "on", attributes: {} },
  "input_number.temperaturspeicher_wohnzimmer": {
    entity_id: "input_number.temperaturspeicher_wohnzimmer",
    state: "18",
    attributes: { min: 12, max: 26, step: 0.5, unit_of_measurement: "°C" },
  },
};

const log = (...args) => console.log("[mock-hass]", ...args);
window.mockCalls = [];

const hass = {
  states,
  language: params.get("lang") || "de",
  locale: { language: params.get("lang") || "de" },
  config: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, unit_system: { temperature: "°C" } },
  themes: { darkMode: !light },
  user: { is_admin: params.get("admin") !== "0" },
  connection: {
    async subscribeMessage(cb, msg) {
      log("subscribe", msg);
      if (msg.plan_id !== plan.id) throw { code: "not_found", message: `Plan '${msg.plan_id}' not found` };
      subscribers.add(cb);
      setTimeout(() => cb({ event: "init", plans: [{ ...plan, status: status() }] }), 50);
      return () => subscribers.delete(cb);
    },
  },
  async callWS(msg) {
    log("callWS", msg);
    window.mockCalls.push(msg);
    if (msg.type === "zeitwerk/plans/list") return { plans: [{ ...plan, status: status() }] };
    if (msg.type === "zeitwerk/plans/update") {
      plan = structuredClone(msg.plan);
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
    if (domain === "switch") {
      plan.enabled = service === "turn_on";
      setTimeout(emit, 30);
    }
  },
};

await import("../../custom_components/zeitwerk/frontend/zeitwerk-card.js");
const card = document.querySelector("zeitwerk-card");
card.setConfig({ type: "custom:zeitwerk-card", plan: params.get("plan") || "wohnzimmer_heizung" });
card.hass = hass;
window.hass = hass;
