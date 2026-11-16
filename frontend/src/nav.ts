/**
 * Navigation inside Home Assistant (shared by card and panel).
 *
 * HA's router listens for the `location-changed` window event; plain
 * `<a href>` links would reload the whole app.
 */
import type { DayKey } from "./day-plan";
import { WEEKDAYS } from "./types";

export const PANEL_PREFIX = "/zeitwerk";

export type Route =
  | { name: "overview" }
  | { name: "plan"; planId: string }
  | { name: "day"; planId: string; day: DayKey }
  | { name: "rules"; planId: string }
  | { name: "profiles"; planId: string }
  | { name: "new"; room?: string; preset?: string }
  | { name: "room"; roomId: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function isDayKey(value: string): value is DayKey {
  return value === "holiday" || (WEEKDAYS as readonly string[]).includes(value);
}

/**
 * Parse the part of the URL below the panel prefix (`route.path` of the
 * panel, e.g. "/plan/heating/day/mon"). Tolerates empty paths, a missing
 * leading slash, trailing slashes, an embedded query string and unknown
 * paths (all fall back to the overview or to the closest valid page).
 */
export function parseRoute(path: string | undefined | null, search = ""): Route {
  let rest = path ?? "";
  let query = search;
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q) || query;
    rest = rest.slice(0, q);
  }
  const parts = rest
    .split("/")
    .filter((p) => p !== "")
    .map(decode);
  const params = new URLSearchParams(query);
  const [head, id, sub, extra] = parts;
  switch (head) {
    case "plan":
      if (!id) return { name: "overview" };
      if (sub === "rules") return { name: "rules", planId: id };
      if (sub === "profiles") return { name: "profiles", planId: id };
      if (sub === "day" && extra && isDayKey(extra)) return { name: "day", planId: id, day: extra };
      return { name: "plan", planId: id };
    case "room":
      return id ? { name: "room", roomId: id } : { name: "overview" };
    case "new": {
      const route: Route = { name: "new" };
      const room = params.get("room");
      const preset = params.get("preset");
      if (room) route.room = room;
      if (preset) route.preset = preset;
      return route;
    }
    default:
      return { name: "overview" };
  }
}

const enc = encodeURIComponent;

/** Absolute path (with panel prefix) of a route. */
export function routePath(route: Route): string {
  switch (route.name) {
    case "overview":
      return PANEL_PREFIX;
    case "plan":
      return `${PANEL_PREFIX}/plan/${enc(route.planId)}`;
    case "day":
      return `${PANEL_PREFIX}/plan/${enc(route.planId)}/day/${route.day}`;
    case "rules":
      return `${PANEL_PREFIX}/plan/${enc(route.planId)}/rules`;
    case "profiles":
      return `${PANEL_PREFIX}/plan/${enc(route.planId)}/profiles`;
    case "room":
      return `${PANEL_PREFIX}/room/${enc(route.roomId)}`;
    case "new": {
      const params = new URLSearchParams();
      if (route.room) params.set("room", route.room);
      if (route.preset) params.set("preset", route.preset);
      const query = params.toString();
      return `${PANEL_PREFIX}/new${query ? `?${query}` : ""}`;
    }
  }
}

/** The page one level up (back arrow of the panel header); null on the overview. */
export function parentRoute(route: Route): Route | null {
  switch (route.name) {
    case "overview":
      return null;
    case "day":
    case "rules":
    case "profiles":
      return { name: "plan", planId: route.planId };
    default:
      return { name: "overview" };
  }
}

/** Switch to `path` without reloading (HA router picks up `location-changed`). */
export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace } }));
}

export function navigateTo(route: Route, replace = false): void {
  navigate(routePath(route), replace);
}

/** Click handler for link-like buttons: opens `path` unless a modifier is held. */
export function openPath(path: string, ev?: MouseEvent): void {
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) {
    window.open(path, "_blank");
    return;
  }
  navigate(path);
}
