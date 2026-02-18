import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionTimer } from '../src/orchestrator/timer.js';

describe('SessionTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExpired after total duration', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const onWarning = vi.fn();
    const onExpired = vi.fn();

    const timer = new SessionTimer(2000, { onTick, onWarning, onExpired });
    timer.start();

    // Advance past total
    vi.advanceTimersByTime(2100);

    expect(onExpired).toHaveBeenCalledTimes(1);
    timer.destroy();
  });

  it('does not fire onExpired before total duration', () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();

    const timer = new SessionTimer(5000, {
      onTick: vi.fn(),
      onWarning: vi.fn(),
      onExpired,
    });
    timer.start();

    vi.advanceTimersByTime(4000);
    expect(onExpired).not.toHaveBeenCalled();
    timer.destroy();
  });

  it('emits client ticks at approximately 1Hz', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();

    const timer = new SessionTimer(10000, {
      onTick,
      onWarning: vi.fn(),
      onExpired: vi.fn(),
    });
    timer.start();

    // Advance 3.5 seconds
    vi.advanceTimersByTime(3500);

    // Should have ~4 ticks (0s, 1s, 2s, 3s)
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onTick.mock.calls.length).toBeLessThanOrEqual(5);
    timer.destroy();
  });

  it('tick provides remaining ms (decreasing)', () => {
    vi.useFakeTimers();
    const ticks: number[] = [];

    const timer = new SessionTimer(5000, {
      onTick: (remaining) => ticks.push(remaining),
      onWarning: vi.fn(),
      onExpired: vi.fn(),
    });
    timer.start();

    vi.advanceTimersByTime(3500);

    // Each tick should have lower remaining than the previous
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeLessThan(ticks[i - 1]);
    }
    timer.destroy();
  });

  it('fires warnings at configured thresholds', () => {
    vi.useFakeTimers();
    const warnings: number[] = [];

    // Use 5s total with warnings at 3s and 1s remaining
    // Default thresholds are 60s and 15s, so use a short timer to test
    // We'll use 180s total and check the 60s warning
    const timer = new SessionTimer(180_000, {
      onTick: vi.fn(),
      onWarning: (remaining) => warnings.push(remaining),
      onExpired: vi.fn(),
    });
    timer.start();

    // Advance to 121s elapsed (59s remaining) -- should trigger 60s warning
    vi.advanceTimersByTime(121_000);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toBeLessThanOrEqual(60_000);

    // Advance to 166s elapsed (14s remaining) -- should trigger 15s warning
    vi.advanceTimersByTime(45_000);
    expect(warnings.length).toBe(2);
    expect(warnings[1]).toBeLessThanOrEqual(15_000);

    timer.destroy();
  });

  it('each warning fires only once', () => {
    vi.useFakeTimers();
    const warnings: number[] = [];

    const timer = new SessionTimer(180_000, {
      onTick: vi.fn(),
      onWarning: (remaining) => warnings.push(remaining),
      onExpired: vi.fn(),
    });
    timer.start();

    // Pass both warning thresholds
    vi.advanceTimersByTime(170_000);

    expect(warnings.length).toBe(2);
    timer.destroy();
  });

  it('destroy prevents further callbacks', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const onExpired = vi.fn();

    const timer = new SessionTimer(5000, {
      onTick,
      onWarning: vi.fn(),
      onExpired,
    });
    timer.start();

    vi.advanceTimersByTime(1000);
    const ticksBeforeDestroy = onTick.mock.calls.length;
    timer.destroy();

    vi.advanceTimersByTime(10_000);

    // No new ticks after destroy
    expect(onTick.mock.calls.length).toBe(ticksBeforeDestroy);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('getRemaining returns correct value', () => {
    vi.useFakeTimers();

    const timer = new SessionTimer(10_000, {
      onTick: vi.fn(),
      onWarning: vi.fn(),
      onExpired: vi.fn(),
    });
    timer.start();

    vi.advanceTimersByTime(3000);
    expect(timer.getRemaining()).toBe(7000);

    vi.advanceTimersByTime(7000);
    expect(timer.getRemaining()).toBe(0);

    timer.destroy();
  });

  it('getRemaining never goes below 0', () => {
    vi.useFakeTimers();

    const timer = new SessionTimer(1000, {
      onTick: vi.fn(),
      onWarning: vi.fn(),
      onExpired: vi.fn(),
    });
    timer.start();

    vi.advanceTimersByTime(5000);
    expect(timer.getRemaining()).toBe(0);
    timer.destroy();
  });
});
