import {
  TIMER_TICK_INTERNAL_MS,
  TIMER_TICK_CLIENT_MS,
  TIMER_WARNING_THRESHOLDS,
} from '@coach/shared';

export interface TimerCallbacks {
  onTick: (remainingMs: number) => void;
  onWarning: (remainingMs: number) => void;
  onExpired: () => void;
}

export class SessionTimer {
  private totalMs: number;
  private startTs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastClientTickMs = 0;
  private firedWarnings = new Set<number>();
  private expired = false;
  private destroyed = false;
  private callbacks: TimerCallbacks;

  constructor(totalMs: number, callbacks: TimerCallbacks) {
    this.totalMs = totalMs;
    this.startTs = Date.now();
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.intervalId) return;

    this.startTs = Date.now();
    this.intervalId = setInterval(() => this.tick(), TIMER_TICK_INTERNAL_MS);
    // Fire immediate first tick
    this.tick();
  }

  getRemaining(): number {
    const elapsed = Date.now() - this.startTs;
    return Math.max(0, this.totalMs - elapsed);
  }

  /** Extend the session deadline. Clears any already-fired warnings that are
   *  now back above the new remaining threshold so they can fire again. */
  extend(extraMs: number): void {
    if (this.destroyed || this.expired) return;
    this.totalMs += extraMs;
    // Re-arm any warnings that were fired but now have time again
    const newRemaining = this.getRemaining();
    for (const threshold of TIMER_WARNING_THRESHOLDS) {
      if (newRemaining > threshold && this.firedWarnings.has(threshold)) {
        this.firedWarnings.delete(threshold);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    if (this.destroyed || this.expired) return;

    const remaining = this.getRemaining();

    // Check warnings (fire each only once)
    for (const threshold of TIMER_WARNING_THRESHOLDS) {
      if (remaining <= threshold && !this.firedWarnings.has(threshold)) {
        this.firedWarnings.add(threshold);
        this.callbacks.onWarning(remaining);
      }
    }

    // Emit client tick at 1Hz
    const now = Date.now();
    if (now - this.lastClientTickMs >= TIMER_TICK_CLIENT_MS) {
      this.lastClientTickMs = now;
      this.callbacks.onTick(remaining);
    }

    // Check expiry
    if (remaining <= 0) {
      this.expired = true;
      this.destroy();
      this.callbacks.onExpired();
    }
  }
}
