import type { HomeAssistant } from "./types";

const BASE_MS = 2000;
const MAX_MS = 30_000;

/** Delay before retry number `attempt` (0-based): 2 s, 4 s, 8 s … capped at 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt));
}

/** Errors that retrying cannot fix: unknown plan, or a backend without that command. */
export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code !== "not_found" && code !== "unknown_command";
}

export interface SubscriptionOptions<T> {
  hass: () => HomeAssistant | undefined;
  msg: Record<string, unknown>;
  onEvent: (event: T) => void;
  /** Called with the error (or undefined once it works again). */
  onError: (err: unknown | undefined) => void;
  /** Whether a failure is worth retrying (default: see `isRetryable`). */
  retry?: (err: unknown) => boolean;
}

/** One websocket subscription that retries with backoff while it fails. */
export class RetrySubscription<T> {
  private _unsub?: Promise<() => Promise<void> | void>;
  private _timer?: number;
  private _attempt = 0;
  private _active = false;

  constructor(private readonly _opts: SubscriptionOptions<T>) {}

  public get active(): boolean {
    return this._active;
  }

  /** Subscribe now (no-op while subscribed or without a connection). */
  public start(): void {
    this._active = true;
    if (this._unsub || !this._opts.hass()?.connection) return;
    window.clearTimeout(this._timer);
    const hass = this._opts.hass()!;
    let unsub: Promise<() => Promise<void> | void>;
    try {
      unsub = hass.connection.subscribeMessage<T>((ev) => {
        this._attempt = 0;
        this._opts.onEvent(ev);
      }, this._opts.msg);
    } catch (err) {
      unsub = Promise.reject(err);
    }
    this._unsub = unsub;
    unsub
      .then(() => {
        if (this._unsub === unsub) this._opts.onError(undefined);
      })
      .catch(() => undefined);
    unsub.catch((err: unknown) => {
      if (this._unsub !== unsub) return;
      this._unsub = undefined;
      this._opts.onError(err);
      const retry = this._opts.retry ?? isRetryable;
      if (this._active && retry(err)) {
        this._timer = window.setTimeout(() => this.start(), backoffMs(this._attempt++));
      }
    });
  }

  /** Retry immediately (retry button). */
  public retryNow(): void {
    if (this._unsub) return;
    this._attempt = 0;
    this.start();
  }

  public stop(): void {
    this._active = false;
    window.clearTimeout(this._timer);
    const unsub = this._unsub;
    this._unsub = undefined;
    this._attempt = 0;
    unsub?.then((fn) => fn()).catch(() => undefined);
  }
}
