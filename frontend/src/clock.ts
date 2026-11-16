import { MINUTES_PER_DAY, zonedNow } from "./time";

/**
 * Keeps `--zw-now` (fraction of the day) on a host element up to date with one
 * timer aligned to the full minute – no re-render needed for the now-line.
 */
export class NowClock {
  private _timer?: number;
  private _weekday?: number;

  constructor(
    private readonly _host: HTMLElement,
    private readonly _timeZone: () => string | undefined,
    /** Called every minute; `dayChanged` when the weekday differs from the last tick. */
    private readonly _onTick?: (info: { minutes: number; dayChanged: boolean }) => void,
  ) {}

  public start(): void {
    if (this._timer !== undefined) return;
    this.update();
    const msToMinute = 60_000 - (Date.now() % 60_000) + 50;
    this._timer = window.setTimeout(() => {
      this.update();
      this._timer = window.setInterval(() => this.update(), 60_000);
    }, msToMinute);
  }

  public stop(): void {
    window.clearTimeout(this._timer);
    window.clearInterval(this._timer);
    this._timer = undefined;
  }

  public update(): void {
    const now = zonedNow(this._timeZone());
    this._host.style.setProperty("--zw-now", String(now.minutes / MINUTES_PER_DAY));
    const dayChanged = this._weekday !== undefined && this._weekday !== now.weekdayIndex;
    this._weekday = now.weekdayIndex;
    this._onTick?.({ minutes: now.minutes, dayChanged });
  }
}
