import type { Plan, PlanEvent } from "./types";

/** Replace the item with the same id or append it (returns a new array). */
export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

/** Apply a `zeitwerk/plans/subscribe` event to a plan list. */
export function applyPlanEvent(plans: Plan[], msg: PlanEvent): Plan[] {
  if (msg.event === "init") return msg.plans ?? [];
  if (msg.event === "removed") return plans.filter((p) => p.id !== msg.plan_id);
  return msg.plan ? upsert(plans, msg.plan) : plans;
}
