/**
 * Day-based editing (one plan per weekday, blocks never cross midnight).
 *
 * The backend still stores day types (docs/SPEC.md §3). The card works on a
 * per-weekday view and regroups weekdays with identical blocks into day types
 * when saving, so the stored format stays unchanged.
 */
import { dayTypeFor, normalize, subtract, toInterval } from "./blocks";
import { daysLabel, type Localizer } from "./localize";
import { MINUTES_PER_DAY, formatTime, parseTime } from "./time";
import { WEEKDAYS, type Block, type DayType, type Plan, type Weekday } from "./types";

export type DayKey = Weekday | "holiday";

/** Resume settings of one day (see docs/SPEC.md §3 "Rücksetzpunkte"). */
export interface DayResume {
  resume_points: string[];
  resume_forced: boolean;
}

export const NO_RESUME: DayResume = { resume_points: [], resume_forced: false };

/** Sorted, de-duplicated resume points of a day type. */
export function resumeOf(dayType: DayType | undefined): DayResume {
  return {
    resume_points: [...new Set(dayType?.resume_points ?? [])].sort(),
    resume_forced: !!dayType?.resume_forced,
  };
}

/** Storage fields of resume settings (omitted when empty, like the backend). */
function resumeFields(r: DayResume): Pick<DayType, "resume_points" | "resume_forced"> {
  return {
    ...(r.resume_points.length ? { resume_points: [...r.resume_points] } : {}),
    ...(r.resume_forced ? { resume_forced: true } : {}),
  };
}

function holidayDayType(plan: Plan): DayType | undefined {
  const holidayId = plan.holidays.mode === "own_day_type" ? plan.holidays.day_type : null;
  return plan.week.day_types.find((d) => d.id === holidayId);
}

/** Resume settings per weekday (and the own holiday day). */
export function weekToResume(plan: Plan): Record<DayKey, DayResume> {
  const out = {} as Record<DayKey, DayResume>;
  for (const wd of WEEKDAYS) out[wd] = resumeOf(dayTypeFor(plan, wd));
  out.holiday = resumeOf(holidayDayType(plan));
  return out;
}

/** Blocks as [start, end) minutes, sorted, 0 <= start < end <= 1440. */
export interface DayBlock {
  start: number;
  end: number;
  profile: string;
}

export function toDayBlocks(blocks: Block[]): DayBlock[] {
  return blocks
    .map((b) => ({
      start: parseTime(b.start) % MINUTES_PER_DAY,
      end: parseTime(b.end) || MINUTES_PER_DAY,
      profile: b.profile,
    }))
    .map((b) => (b.end <= b.start ? { ...b, end: MINUTES_PER_DAY } : b))
    .sort((a, b) => a.start - b.start);
}

export function fromDayBlocks(blocks: DayBlock[]): Block[] {
  // Merge touching blocks of the same profile, drop empty ones.
  return normalize(blocks.filter((b) => b.end > b.start).map((b) => ({ ...b }))).map((iv) => ({
    start: formatTime(iv.start),
    end: formatTime(iv.end),
    profile: iv.profile,
  }));
}

/**
 * The effective blocks of every weekday without midnight crossing: own blocks
 * clipped at 24:00 plus the morning part of yesterday's crossing blocks
 * (today's blocks win, as in the engine). The holiday day type (own mode) is
 * clipped only.
 */
export function weekToDays(plan: Plan): Record<DayKey, Block[]> {
  const out = {} as Record<DayKey, Block[]>;
  WEEKDAYS.forEach((wd, i) => {
    const own = (dayTypeFor(plan, wd)?.blocks ?? []).map(toInterval);
    const prev = (dayTypeFor(plan, WEEKDAYS[(i + 6) % 7])?.blocks ?? []).map(toInterval);
    const day: DayBlock[] = own.map((iv) => ({
      start: iv.start,
      end: Math.min(iv.end, MINUTES_PER_DAY),
      profile: iv.profile,
    }));
    const ownPieces = day.map((b): [number, number] => [b.start, b.end]);
    for (const iv of prev) {
      if (iv.end <= MINUTES_PER_DAY) continue;
      for (const [s, e] of subtract([[0, iv.end - MINUTES_PER_DAY]], ownPieces)) {
        day.push({ start: s, end: e, profile: iv.profile });
      }
    }
    out[wd] = fromDayBlocks(day.sort((a, b) => a.start - b.start));
  });
  const holidayId = plan.holidays.mode === "own_day_type" ? plan.holidays.day_type : null;
  const holiday = plan.week.day_types.find((d) => d.id === holidayId);
  out.holiday = holiday ? fromDayBlocks(toDayBlocks(holiday.blocks)) : [];
  return out;
}

const key = (blocks: Block[], resume: DayResume) => JSON.stringify({ blocks, ...resume });

/**
 * Regroup weekdays with identical blocks and resume settings into day types.
 * Existing day types keep id and name when their weekday set is unchanged;
 * new groups are named after their days ("Mo–Fr", "Mi").
 */
export function daysToWeek(
  plan: Plan,
  days: Record<DayKey, Block[]>,
  l: Localizer,
  resume: Record<DayKey, DayResume> = weekToResume(plan),
): DayType[] {
  const groups = new Map<string, Weekday[]>();
  for (const wd of WEEKDAYS) {
    const k = key(days[wd] ?? [], resume[wd] ?? NO_RESUME);
    groups.set(k, [...(groups.get(k) ?? []), wd]);
  }
  const holidayId = plan.holidays.mode === "own_day_type" ? plan.holidays.day_type : null;
  const taken = new Set<string>(holidayId ? [holidayId] : []);
  const result: DayType[] = [];
  for (const [k, wds] of groups) {
    const same = plan.week.day_types.find(
      (d) =>
        d.id !== holidayId && d.days.length === wds.length && wds.every((w) => d.days.includes(w)),
    );
    let id = same?.id ?? wds.join("_");
    for (let i = 2; taken.has(id); i++) id = `${wds.join("_")}_${i}`;
    taken.add(id);
    const group = JSON.parse(k) as { blocks: Block[] } & DayResume;
    result.push({
      id,
      name:
        same?.name ??
        daysLabel(
          wds.map((w) => WEEKDAYS.indexOf(w)),
          l,
        ),
      days: wds,
      blocks: group.blocks,
      ...resumeFields(group),
    });
  }
  if (holidayId) {
    const old = plan.week.day_types.find((d) => d.id === holidayId);
    result.push({
      id: holidayId,
      name: old?.name ?? l.t("holiday"),
      days: [],
      blocks: days.holiday ?? [],
      ...resumeFields(resume.holiday ?? NO_RESUME),
    });
  }
  return result;
}

/**
 * Set `blocks` (and `resume`, if given) on all `targets` and regroup
 * (mutates `plan`). Without `resume` every target keeps its own settings.
 */
export function applyDayPlan(
  plan: Plan,
  targets: DayKey[],
  blocks: Block[],
  l: Localizer,
  resume?: DayResume,
): void {
  const days = weekToDays(plan);
  const resumes = weekToResume(plan);
  for (const t of targets) {
    days[t] = blocks.map((b) => ({ ...b }));
    if (resume) resumes[t] = { ...resume, resume_points: [...resume.resume_points].sort() };
  }
  plan.week.day_types = daysToWeek(plan, days, l, resumes);
}

// --- Editing within one day ---------------------------------------------------

/** Free gap that contains `minute` (or null if inside a block). */
export function gapAt(blocks: DayBlock[], minute: number): [number, number] | null {
  let start = 0;
  for (const b of blocks) {
    if (minute >= b.start && minute < b.end) return null;
    if (b.end <= minute) start = Math.max(start, b.end);
  }
  const next = blocks.find((b) => b.start > minute);
  return [start, next ? next.start : MINUTES_PER_DAY];
}

/** Add a block of up to `length` minutes at `minute` (snapped), or in the first free gap. */
export function addBlock(
  blocks: DayBlock[],
  profile: string,
  step: number,
  minute?: number,
  length = 120,
): { blocks: DayBlock[]; index: number } | null {
  const candidates =
    minute !== undefined
      ? [Math.floor(minute / step) * step]
      : [6 * 60, ...blocks.map((b) => b.end), 0];
  for (const m of candidates) {
    const probe = Math.min(m, MINUTES_PER_DAY - 1);
    const gap = gapAt(blocks, minute !== undefined ? minute : probe);
    if (!gap) continue;
    const start = Math.max(gap[0], Math.min(m, gap[1] - step));
    if (gap[1] - start < step) continue;
    const block = { start, end: Math.min(start + length, gap[1]), profile };
    const next = [...blocks, block].sort((x, y) => x.start - y.start);
    return { blocks: next, index: next.indexOf(block) };
  }
  return null;
}

export type DragMode = "start" | "end" | "move";

/**
 * Drag one block's edge or the whole block by `delta` minutes, snapped to
 * `step`, stopping at neighbouring blocks and at 0:00 / 24:00.
 */
export function dragDayBlock(
  blocks: DayBlock[],
  index: number,
  mode: DragMode,
  delta: number,
  step: number,
): DayBlock[] {
  const b = blocks[index];
  if (!b) return blocks;
  const lo = index > 0 ? blocks[index - 1].end : 0;
  const hi = index < blocks.length - 1 ? blocks[index + 1].start : MINUTES_PER_DAY;
  const snap = (m: number) => Math.round(m / step) * step;
  let { start, end } = b;
  if (mode === "start") start = Math.max(lo, Math.min(snap(b.start + delta), b.end - step));
  else if (mode === "end") end = Math.min(hi, Math.max(snap(b.end + delta), b.start + step));
  else {
    const len = b.end - b.start;
    start = Math.max(lo, Math.min(snap(b.start + delta), hi - len));
    end = start + len;
  }
  return blocks.map((x, i) => (i === index ? { ...x, start, end } : x));
}

/**
 * Set a block's start or end to a typed minute, clamped between the
 * neighbouring blocks (and 0:00 / 24:00); a block keeps at least one minute.
 */
export function setBlockTime(
  blocks: DayBlock[],
  index: number,
  mode: "start" | "end",
  minute: number,
): DayBlock[] {
  const b = blocks[index];
  if (!b) return blocks;
  const lo = index > 0 ? blocks[index - 1].end : 0;
  const hi = index < blocks.length - 1 ? blocks[index + 1].start : MINUTES_PER_DAY;
  let { start, end } = b;
  if (mode === "start") start = Math.max(lo, Math.min(minute, b.end - 1));
  else end = Math.min(hi, Math.max(minute, b.start + 1));
  return blocks.map((x, i) => (i === index ? { ...x, start, end } : x));
}

/** Move a resume point to `minute` (0:00–23:59); null if that time is taken. */
export function moveResumePoint(points: number[], index: number, minute: number): number[] | null {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(minute)));
  if (points.some((p, i) => i !== index && p === m)) return null;
  return points.map((p, i) => (i === index ? m : p));
}
