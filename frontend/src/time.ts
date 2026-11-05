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

/** Format minutes since midnight as "HH:MM" (1440 -> "24:00"). */
export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
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

/** Day number (days since epoch of the local calendar date) and minute of day in a time zone. */
function zonedDay(date: Date, timeZone: string | undefined): { day: number; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
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
