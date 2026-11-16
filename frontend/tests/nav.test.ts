import { afterEach, describe, expect, it, vi } from "vitest";
import { linkClick, navigate, navigateTo, parentRoute, parseRoute, routePath } from "../src/nav";

describe("parseRoute", () => {
  it("parses all routes", () => {
    expect(parseRoute("")).toEqual({ name: "overview" });
    expect(parseRoute("/plan/heat")).toEqual({ name: "plan", planId: "heat" });
    expect(parseRoute("/plan/heat/day/mon")).toEqual({ name: "day", planId: "heat", day: "mon" });
    expect(parseRoute("/plan/heat/day/holiday")).toEqual({
      name: "day",
      planId: "heat",
      day: "holiday",
    });
    expect(parseRoute("/plan/heat/rules")).toEqual({ name: "rules", planId: "heat" });
    expect(parseRoute("/plan/heat/profiles")).toEqual({ name: "profiles", planId: "heat" });
    expect(parseRoute("/new")).toEqual({ name: "new" });
    expect(parseRoute("/room/living")).toEqual({ name: "room", roomId: "living" });
    expect(parseRoute("/room/new")).toEqual({ name: "room_new" });
  });

  it("tolerates empty, missing and odd paths", () => {
    expect(parseRoute(undefined)).toEqual({ name: "overview" });
    expect(parseRoute(null)).toEqual({ name: "overview" });
    expect(parseRoute("/")).toEqual({ name: "overview" });
    expect(parseRoute("plan/heat/")).toEqual({ name: "plan", planId: "heat" });
    expect(parseRoute("/nonsense/foo")).toEqual({ name: "overview" });
    expect(parseRoute("/plan")).toEqual({ name: "overview" });
    expect(parseRoute("/room")).toEqual({ name: "overview" });
  });

  it("falls back to the plan page for an unknown day or sub page", () => {
    expect(parseRoute("/plan/heat/day/xyz")).toEqual({ name: "plan", planId: "heat" });
    expect(parseRoute("/plan/heat/day")).toEqual({ name: "plan", planId: "heat" });
    expect(parseRoute("/plan/heat/other")).toEqual({ name: "plan", planId: "heat" });
  });

  it("keeps unknown plan ids (resolved against the backend later) and decodes them", () => {
    expect(parseRoute("/plan/does_not_exist")).toEqual({
      name: "plan",
      planId: "does_not_exist",
    });
    expect(parseRoute("/plan/a%20b")).toEqual({ name: "plan", planId: "a b" });
    expect(parseRoute("/plan/%E0%A4%A")).toEqual({ name: "plan", planId: "%E0%A4%A" });
  });

  it("reads the reserved ?room= query (from path or search)", () => {
    expect(parseRoute("/new?room=living")).toEqual({ name: "new", room: "living" });
    expect(parseRoute("/new", "?room=bath")).toEqual({ name: "new", room: "bath" });
    expect(parseRoute("/new", "?preset=heat")).toEqual({ name: "new", preset: "heat" });
    expect(parseRoute("/plan/heat", "?room=x")).toEqual({ name: "plan", planId: "heat" });
  });
});

describe("routePath / parentRoute", () => {
  it("round-trips routes", () => {
    for (const path of [
      "/plan/heat",
      "/plan/heat/day/sun",
      "/plan/heat/rules",
      "/plan/heat/profiles",
      "/room/living",
      "/room/new",
      "/new",
      "/new?room=living",
    ]) {
      expect(routePath(parseRoute(path))).toBe(`/zeitwerk${path}`);
    }
    expect(routePath({ name: "overview" })).toBe("/zeitwerk");
  });

  it("goes one level up", () => {
    expect(parentRoute({ name: "overview" })).toBeNull();
    expect(parentRoute({ name: "day", planId: "a", day: "mon" })).toEqual({
      name: "plan",
      planId: "a",
    });
    expect(parentRoute({ name: "rules", planId: "a" })).toEqual({ name: "plan", planId: "a" });
    expect(parentRoute({ name: "plan", planId: "a" })).toEqual({ name: "overview" });
    expect(parentRoute({ name: "new" })).toEqual({ name: "overview" });
    expect(parentRoute({ name: "room_new" })).toEqual({ name: "overview" });
  });
});

describe("navigate", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub() {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    const events: CustomEvent[] = [];
    const win = { dispatchEvent: vi.fn((ev: CustomEvent) => events.push(ev)) };
    vi.stubGlobal("history", history);
    vi.stubGlobal("window", win);
    return { history, events };
  }

  it("pushes the path and fires location-changed", () => {
    const { history, events } = stub();
    navigate("/zeitwerk/plan/heat");
    expect(history.pushState).toHaveBeenCalledWith(null, "", "/zeitwerk/plan/heat");
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("location-changed");
    expect(events[0].detail).toEqual({ replace: false });
  });

  it("can replace the history entry", () => {
    const { history, events } = stub();
    navigateTo({ name: "overview" }, true);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/zeitwerk");
    expect(history.pushState).not.toHaveBeenCalled();
    expect(events[0].detail).toEqual({ replace: true });
  });
});

describe("linkClick", () => {
  afterEach(() => vi.unstubAllGlobals());

  function click(init: Partial<MouseEvent>) {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    vi.stubGlobal("history", history);
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const ev = {
      button: 0,
      defaultPrevented: false,
      preventDefault: vi.fn(),
      ...init,
    } as unknown as MouseEvent;
    linkClick("/zeitwerk/new")(ev);
    return { history, ev };
  }

  it("navigates in-app on a plain left click", () => {
    const { history, ev } = click({});
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledWith(null, "", "/zeitwerk/new");
  });

  it("leaves modified and middle clicks to the browser", () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const { history, ev } = click(init);
      expect(ev.preventDefault).not.toHaveBeenCalled();
      expect(history.pushState).not.toHaveBeenCalled();
    }
  });
});
