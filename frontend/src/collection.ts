import type { Plan, PlanEvent, Room, RoomEvent } from "./types";

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

/** Apply a `zeitwerk/rooms/subscribe` event to a room list. */
export function applyRoomEvent(rooms: Room[], msg: RoomEvent): Room[] {
  if (msg.event === "init") return msg.rooms ?? [];
  if (msg.event === "removed") return rooms.filter((r) => r.id !== msg.room_id);
  return msg.room ? upsert(rooms, msg.room) : rooms;
}
