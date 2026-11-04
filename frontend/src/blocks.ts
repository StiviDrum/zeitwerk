/**
 * Block maths on the 24 h circle.
 *
 * A block is stored as "HH:MM" strings; `end <= start` means it runs across
 * midnight into the next day (docs/SPEC.md §3). Internally a block is an
 * interval [start, end) in minutes with 0 <= start < 1440 and
 * start < end <= start + 1440. Within one day type blocks must not overlap on
 * the circle (the backend validates the same rule).
 */
import { MINUTES_PER_DAY, formatTime, parseTime } from "./time";
import { WEEKDAYS, type Block, type DayType, type Plan, type Weekday } from "./types";

export interface Interval {
  start: number;
  end: number;
  profile: string;
}

type Piece = [number, number];

export function toInterval(block: Block): Interval {
  const start = parseTime(block.start) % MINUTES_PER_DAY;
  let end = parseTime(block.end);
  if (end <= start) end += MINUTES_PER_DAY;
  return { start, end, profile: block.profile };
}

export function fromInterval(iv: Interval): Block {
  const end = iv.end <= MINUTES_PER_DAY ? iv.end : iv.end - MINUTES_PER_DAY;
  return { start: formatTime(iv.start), end: formatTime(end), profile: iv.profile };
}

export function crossesMidnight(iv: Interval): boolean {
  return iv.end > MINUTES_PER_DAY;
}

/** Linear pieces within [0, 1440] (one, or two for blocks across midnight). */
function pieces(iv: Interval): Piece[] {
  if (iv.end <= MINUTES_PER_DAY) return [[iv.start, iv.end]];
  return [
    [iv.start, MINUTES_PER_DAY],
    [0, iv.end - MINUTES_PER_DAY],
  ];
}

function subtract(from: Piece[], cut: Piece[]): Piece[] {
  let rest = from;
  for (const [cs, ce] of cut) {
    const next: Piece[] = [];
    for (const [s, e] of rest) {
      if (ce <= s || cs >= e) {
        next.push([s, e]);
        continue;
      }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    rest = next;
  }
  return rest;
}

/** What is left of `iv` after removing `cut`; keeps the midnight crossing when possible. */
function cutInterval(iv: Interval, cut: Interval): Interval[] {
  const rest = subtract(pieces(iv), pieces(cut)).filter(([s, e]) => e > s);
  if (crossesMidnight(iv)) {
    const evening = rest.find(([, e]) => e === MINUTES_PER_DAY);
    const morning = rest.find(([s]) => s === 0);
    if (evening && morning && evening !== morning) {
      const joined: Interval = {
        start: evening[0],
        end: MINUTES_PER_DAY + morning[1],
        profile: iv.profile,
      };
      const others = rest.filter((p) => p !== evening && p !== morning);
      return [joined, ...others.map(([s, e]) => ({ start: s, end: e, profile: iv.profile }))];
    }
  }
  return rest.map(([s, e]) => ({ start: s % MINUTES_PER_DAY, end: e, profile: iv.profile }));
}

/** Sort by start and merge touching blocks of the same profile. */
export function normalize(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start)
    .map((iv) => ({ ...iv }));
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && last.profile === iv.profile && last.end === iv.start) {
      last.end = iv.end;
    } else {
      out.push(iv);
    }
  }
  // A block across midnight may touch the first block of the day.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      crossesMidnight(last) &&
      last.profile === first.profile &&
      last.end - MINUTES_PER_DAY === first.start &&
      last.end - last.start + (first.end - first.start) <= MINUTES_PER_DAY
    ) {
      last.end = first.end + MINUTES_PER_DAY;
      out.shift();
    }
  }
  return out;
}

/**
 * Insert a block into a day type: existing blocks are trimmed or split where
 * the new block covers them. A block of the default profile only clears the
 * range (outside all blocks the default profile applies anyway).
 */
export function insertBlock(blocks: Block[], block: Block, defaultProfile: string): Block[] {
  const added = toInterval(block);
  const kept = blocks.flatMap((b) => cutInterval(toInterval(b), added));
  if (added.profile !== defaultProfile) kept.push(added);
  return normalize(kept).map(fromInterval);
}

/** Replace the block at `index` (edit in the sheet). */
export function replaceBlock(
  blocks: Block[],
  index: number,
  block: Block,
  defaultProfile: string,
): Block[] {
  return insertBlock(
    blocks.filter((_, i) => i !== index),
    block,
    defaultProfile,
  );
}

export function removeBlock(blocks: Block[], index: number): Block[] {
  return blocks.filter((_, i) => i !== index);
}

/** Free minutes after `start` until the next block (for new blocks). */
export function freeUntil(blocks: Block[], start: number): number {
  let best = start + MINUTES_PER_DAY;
  for (const b of blocks) {
    const iv = toInterval(b);
    for (const [s] of [[iv.start], [iv.start + MINUTES_PER_DAY]]) {
      if (s > start && s < best) best = s;
    }
  }
  return best;
}

/** Index of the block covering `minute` (incl. the spill part across midnight), or -1. */
export function blockAt(blocks: Block[], minute: number): number {
  return blocks.findIndex((b) => pieces(toInterval(b)).some(([s, e]) => minute >= s && minute < e));
}

// --- Week grid rows ---------------------------------------------------------

export interface Segment {
  /** Position in % of the day. */
  left: number;
  width: number;
  profile: string;
  label: string;
  dayType: string;
  index: number;
  /** Part of a block that started on the previous day. */
  spill: boolean;
}

export function dayTypeFor(plan: Plan, weekday: Weekday): DayType | undefined {
  return plan.week.day_types.find((d) => d.days.includes(weekday));
}

export function previousWeekday(weekday: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(weekday) + 6) % 7];
}

const pct = (minutes: number) => (minutes / MINUTES_PER_DAY) * 100;

function label(iv: Interval): string {
  return `${formatTime(iv.start)}–${formatTime(iv.end % MINUTES_PER_DAY || MINUTES_PER_DAY)}`;
}

/**
 * Segments to draw in one row: the day type's own blocks plus the part of
 * yesterday's blocks that runs past midnight (today's blocks win).
 */
export function rowSegments(
  dayType: DayType | undefined,
  previous: DayType | undefined,
): Segment[] {
  const out: Segment[] = [];
  const own: Piece[] = [];
  dayType?.blocks.forEach((b, index) => {
    const iv = toInterval(b);
    const end = Math.min(iv.end, MINUTES_PER_DAY);
    own.push([iv.start, end]);
    out.push({
      left: pct(iv.start),
      width: pct(end - iv.start),
      profile: iv.profile,
      label: label(iv),
      dayType: dayType.id,
      index,
      spill: false,
    });
  });
  previous?.blocks.forEach((b, index) => {
    const iv = toInterval(b);
    if (!crossesMidnight(iv)) return;
    for (const [s, e] of subtract([[0, iv.end - MINUTES_PER_DAY]], own)) {
      if (e <= s) continue;
      out.push({
        left: pct(s),
        width: pct(e - s),
        profile: iv.profile,
        label: label(iv),
        dayType: previous.id,
        index,
        spill: true,
      });
    }
  });
  return out.sort((a, b) => a.left - b.left);
}

// --- Drag / keyboard editing -------------------------------------------------

export type Edge = "start" | "end" | "move";

/**
 * Block after dragging an edge (or the whole block) by `delta` minutes,
 * snapped to `step`. Keeps at least one step of duration; the end may run past
 * midnight (up to 24 h after the start), the start stays on the block's day.
 */
export function dragBlock(block: Block, edge: Edge, delta: number, step: number): Block {
  const iv = toInterval(block);
  let { start, end } = iv;
  if (edge === "start") {
    const s = Math.round((start + delta) / step) * step;
    start = Math.max(Math.max(0, end - MINUTES_PER_DAY), Math.min(s, end - step));
    start = Math.min(start, MINUTES_PER_DAY - step);
  } else if (edge === "end") {
    const e = Math.round((end + delta) / step) * step;
    end = Math.max(start + step, Math.min(e, start + MINUTES_PER_DAY));
  } else {
    const length = end - start;
    const s = Math.round((start + delta) / step) * step;
    start = Math.max(0, Math.min(s, MINUTES_PER_DAY - step));
    end = start + length;
  }
  return fromInterval({ start, end, profile: iv.profile });
}

/** Copy all blocks of one day type to others (replacing their blocks). */
export function copyDayType(plan: Plan, fromId: string, toIds: string[]): void {
  const from = plan.week.day_types.find((d) => d.id === fromId);
  if (!from) return;
  for (const dt of plan.week.day_types) {
    if (dt.id !== fromId && toIds.includes(dt.id)) {
      dt.blocks = from.blocks.map((b) => ({ ...b }));
    }
  }
}

/**
 * Detach one weekday from its day type so it can be edited on its own.
 * Reuses an existing day type that holds only this weekday; otherwise creates
 * one (copy of the blocks) named `name`. Mutates `plan`, returns the id.
 */
export function detachDay(plan: Plan, weekday: Weekday, name: string): string {
  const current = dayTypeFor(plan, weekday);
  if (current && current.days.length === 1) return current.id;
  const ids = plan.week.day_types.map((d) => d.id);
  let id: string = weekday;
  for (let i = 2; ids.includes(id); i++) id = `${weekday}_${i}`;
  plan.week.day_types.push({
    id,
    name,
    days: [weekday],
    blocks: current ? current.blocks.map((b) => ({ ...b })) : [],
  });
  if (current) current.days = current.days.filter((d) => d !== weekday);
  return id;
}
