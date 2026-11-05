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

export type Piece = [number, number];

export function toInterval(block: Block): Interval {
  const start = parseTime(block.start) % MINUTES_PER_DAY;
  let end = parseTime(block.end);
  if (end <= start) end += MINUTES_PER_DAY;
  return { start, end, profile: block.profile };
}

export function crossesMidnight(iv: Interval): boolean {
  return iv.end > MINUTES_PER_DAY;
}

/** Remove the `cut` ranges from `from` (all linear within one day). */
export function subtract(from: Piece[], cut: Piece[]): Piece[] {
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

/** Sort by start, drop empty blocks and merge touching blocks of the same profile. */
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
  return out;
}

// --- Week grid rows ---------------------------------------------------------

export interface Segment {
  /** Position in % of the day. */
  left: number;
  width: number;
  profile: string;
  /** Full time span, e.g. "06:00–08:00". */
  label: string;
  /** Short form when the full span does not fit: start time ("–08:00" for spills). */
  short: string;
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
      short: formatTime(iv.start),
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
        short: `–${formatTime(iv.end - MINUTES_PER_DAY)}`,
        dayType: previous.id,
        index,
        spill: true,
      });
    }
  });
  return out.sort((a, b) => a.left - b.left);
}

// --- Drag / keyboard editing -------------------------------------------------
