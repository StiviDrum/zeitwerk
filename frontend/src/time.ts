import { WEEKDAYS, type Weekday } from "./types";

export const MINUTES_PER_DAY = 1440;

/** Minutes since midnight for "HH:MM" (24:00 allowed as end of day). */
export function parseTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`Invalid time: ${value}`);
  return h * 60 + m;
}

/**
 * Parse a typed time: "7", "07", "730", "0730", "7:30", "7.30", "07:30",
 * "24:00". Returns minutes since midnight or null if invalid.
 */
export function parseTimeInput(text: string): number | null {
  const t = text.trim().replace(/[.,h]/g, ":");
  let h: number;
  let m: number;
  let match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (match) {
    h = Number(match[1]);
    m = match[2] === undefined ? 0 : Number(match[2]);
    if (match[2] !== undefined && match[2].length === 1) m *= 10; // "7:3" -> 07:30
  } else if ((match = /^(\d{1,2})(\d{2})$/.exec(t))) {
    h = Number(match[1]);
    m = Number(match[2]);
  } else return null;
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

/** Format minutes since midnight as "HH:MM" (1440 -> "24:00"). */
export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const FORMATS: Record<"clock" | "day", Intl.DateTimeFormatOptions> = {
  clock: { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  day: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
};
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached formatter (creating Intl.DateTimeFormat is comparatively expensive). */
function formatter(timeZone: string | undefined, kind: "clock" | "day"): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ""}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, ...FORMATS[kind] });
    formatters.set(key, f);
  }
  return f;
}

export interface ZonedNow {
  weekday: Weekday;
  /** Index 0 = Monday. */
  weekdayIndex: number;
  minutes: number;
}

/** Current weekday and minute of day in the given IANA time zone (HA server zone). */
export function zonedNow(timeZone: string | undefined, date: Date = new Date()): ZonedNow {
  let weekdayIndex: number;
  let minutes: number;
  try {
    const parts = formatter(timeZone, "clock").formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
    minutes = Number(get("hour")) * 60 + Number(get("minute"));
  } catch {
    weekdayIndex = (date.getDay() + 6) % 7;
    minutes = date.getHours() * 60 + date.getMinutes();
  }
  return { weekday: WEEKDAYS[weekdayIndex], weekdayIndex, minutes };
}

/** "HH:MM" of an ISO timestamp in the given time zone. */
export function zonedClock(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const { minutes } = zonedNow(timeZone, date);
  return formatTime(minutes);
}

/**
 * Clock time of an ISO timestamp for "from …" / "until …" texts: "05:15" when
 * it is today (in the given time zone), otherwise with the short weekday
 * ("Mo 05:15") – also for tomorrow, so a time after midnight is unambiguous.
 */
export function zonedWhen(
  iso: string,
  timeZone: string | undefined,
  weekdayShort: (index: number) => string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const { minutes, weekdayIndex } = zonedNow(timeZone, date);
  const clock = formatTime(minutes);
  return zonedDay(date, timeZone).day === zonedDay(now, timeZone).day
    ? clock
    : `${weekdayShort(weekdayIndex)} ${clock}`;
}

/** Day number (days since epoch of the local calendar date) and minute of day in a time zone. */
function zonedDay(date: Date, timeZone: string | undefined): { day: number; minutes: number } {
  try {
    const parts = formatter(timeZone, "day").formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return {
      day: Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / 86_400_000),
      minutes: get("hour") * 60 + get("minute"),
    };
  } catch {
    return {
      day: Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000),
      minutes: date.getHours() * 60 + date.getMinutes(),
    };
  }
}

/** Minutes of `iso` relative to the start of today (zoned); may be negative or > 1440. */
export function minutesFromToday(
  iso: string,
  timeZone: string | undefined,
  now = new Date(),
): number {
  const t = zonedDay(new Date(iso), timeZone);
  const n = zonedDay(now, timeZone);
  return (t.day - n.day) * MINUTES_PER_DAY + t.minutes;
}
