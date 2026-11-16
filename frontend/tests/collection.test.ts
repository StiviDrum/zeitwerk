import { describe, expect, it, vi, afterEach } from "vitest";
import { applyPlanEvent, applyRoomEvent, upsert } from "../src/collection";
import { backoffMs, isRetryable, RetrySubscription } from "../src/subscription";
import { buildPlan } from "../src/wizard";
import type { HomeAssistant, Plan, PlanEvent, Room } from "../src/types";

const p = (id: string, name = id) => ({ id, name }) as Plan;
const r = (id: string) => ({ id, name: id }) as Room;

describe("collections", () => {
  it("upserts without mutating", () => {
    const list = [p("a"), p("b")];
    expect(upsert(list, p("b", "B2")).map((x) => x.name)).toEqual(["a", "B2"]);
    expect(upsert(list, p("c")).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(list).toHaveLength(2);
  });

  it("applies plan and room events", () => {
    expect(applyPlanEvent([], { event: "init", plans: [p("a")] }).map((x) => x.id)).toEqual(["a"]);
    expect(applyPlanEvent([p("a")], { event: "removed", plan_id: "a" })).toEqual([]);
    expect(applyPlanEvent([p("a")], { event: "added", plan_id: "b", plan: p("b") })).toHaveLength(
      2,
    );
    expect(applyRoomEvent([r("a")], { event: "updated", room_id: "a", room: r("a") })).toHaveLength(
      1,
    );
    expect(applyRoomEvent([r("a")], { event: "removed", room_id: "a", room: null })).toEqual([]);
    expect(applyRoomEvent([], { event: "init", rooms: [r("x")] })).toHaveLength(1);
  });
});

describe("wizard room prefill", () => {
  const profiles = [
    { id: "comfort", name: "Comfort", color: null, icon: null, actions: [] },
    { id: "frost", name: "Frost", color: null, icon: null, actions: [] },
  ];
  const draft = { name: "Heat", icon: "", tags: [], layout: "daily" as const };
  const labels = { workday: "w", weekend: "e", daily: "d" };

  it("sets room and window reaction", () => {
    const plan = buildPlan(
      { ...draft, room: "living", windowProfile: "frost" },
      profiles,
      "comfort",
      labels,
    );
    expect(plan.room).toBe("living");
    expect(plan.room_reactions).toEqual({ window: "frost" });
  });

  it("omits the reaction for none or unknown profiles and the room for general plans", () => {
    const none = buildPlan(
      { ...draft, room: "living", windowProfile: "" },
      profiles,
      "comfort",
      labels,
    );
    expect(none.room).toBe("living");
    expect(none.room_reactions).toBeUndefined();
    const unknown = buildPlan(
      { ...draft, room: "living", windowProfile: "gone" },
      profiles,
      "comfort",
      labels,
    );
    expect(unknown.room_reactions).toBeUndefined();
    const general = buildPlan(draft, profiles, "comfort", labels);
    expect(general.room).toBeUndefined();
    expect(general.room_reactions).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("doubles and caps", () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000]);
  });
});

describe("isRetryable", () => {
  it("does not retry not_found or unknown_command", () => {
    expect(isRetryable({ code: "not_found" })).toBe(false);
    expect(isRetryable({ code: "unknown_command" })).toBe(false);
    expect(isRetryable({ code: "boom" })).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
  });
});

describe("RetrySubscription", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(fail: number, code = "boom") {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
      clearTimeout: (id?: number) => clearTimeout(id),
    });
    let calls = 0;
    const unsubscribed = vi.fn();
    const hass = {
      connection: {
        subscribeMessage: vi.fn(async (cb: (e: PlanEvent) => void) => {
          calls++;
          if (calls <= fail) throw { code, message: "nope" };
          cb({ event: "init", plans: [] });
          return unsubscribed;
        }),
      },
    } as unknown as HomeAssistant;
    const errors: unknown[] = [];
    const events: PlanEvent[] = [];
    const sub = new RetrySubscription<PlanEvent>({
      hass: () => hass,
      msg: { type: "x" },
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
    });
    return { sub, hass, errors, events, unsubscribed };
  }

  it("retries with backoff until it works, then clears the error", async () => {
    const { sub, hass, errors, events } = setup(2);
    sub.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(hass.connection.subscribeMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(hass.connection.subscribeMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(hass.connection.subscribeMessage).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(1);
    expect(errors[errors.length - 1]).toBeUndefined();
    expect(errors.filter(Boolean)).toHaveLength(2);
  });

  it("does not retry not_found and stops on stop()", async () => {
    const nf = setup(5, "not_found");
    nf.sub.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nf.hass.connection.subscribeMessage).toHaveBeenCalledTimes(1);

    const s = setup(5);
    s.sub.start();
    await vi.advanceTimersByTimeAsync(0);
    s.sub.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.hass.connection.subscribeMessage).toHaveBeenCalledTimes(1);
  });

  it("retryNow retries immediately and stop unsubscribes", async () => {
    const { sub, hass, unsubscribed } = setup(1);
    sub.start();
    await vi.advanceTimersByTimeAsync(0);
    sub.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(hass.connection.subscribeMessage).toHaveBeenCalledTimes(2);
    sub.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });
});
