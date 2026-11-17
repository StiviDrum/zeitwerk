import { describe, expect, it, vi, afterEach } from "vitest";
import { applyPlanEvent, upsert } from "../src/collection";
import { backoffMs, isRetryable, RetrySubscription } from "../src/subscription";
import type { HomeAssistant, Plan, PlanEvent } from "../src/types";

const p = (id: string, name = id) => ({ id, name }) as Plan;

describe("collections", () => {
  it("upserts without mutating", () => {
    const list = [p("a"), p("b")];
    expect(upsert(list, p("b", "B2")).map((x) => x.name)).toEqual(["a", "B2"]);
    expect(upsert(list, p("c")).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(list).toHaveLength(2);
  });

  it("applies plan events", () => {
    expect(applyPlanEvent([], { event: "init", plans: [p("a")] }).map((x) => x.id)).toEqual(["a"]);
    expect(applyPlanEvent([p("a")], { event: "removed", plan_id: "a" })).toEqual([]);
    expect(applyPlanEvent([p("a")], { event: "added", plan_id: "b", plan: p("b") })).toHaveLength(
      2,
    );
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
