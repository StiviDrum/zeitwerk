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

/** Short label for block captions: "16–22", "6:30–8". */
export function shortTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24 || (minutes === MINUTES_PER_DAY ? 24 : 0);
  const m = minutes % 60;
  return m ? `${h}:${String(m).padStart(2, "0")}` : String(h);
}

/** Round to the nearest multiple of `step` minutes. */
export function snap(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Positive modulo onto the 24 h circle. */
export function wrap(minutes: number): number {
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Human duration "2 h 15 min" / "45 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
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
