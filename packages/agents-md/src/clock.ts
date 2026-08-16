// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.

/**
 * Injectable clock interface for deterministic timestamps in tests.
 * Production code uses `RealClock`; tests inject `FakeClock`.
 */
export interface Clock {
  /** Returns the current time as milliseconds since epoch. */
  now(): number;
}

/** Real wall-clock implementation used in production. */
export const RealClock: Clock = {
  now: () => Date.now(),
};

/**
 * Fake clock for deterministic tests.
 * @example
 * const clock = new FakeClock(1_000_000);
 * clock.advance(500); // now() === 1_000_500
 */
export class FakeClock implements Clock {
  constructor(private _now: number = 0) {}

  now(): number {
    return this._now;
  }

  /** Advance the fake clock by `ms` milliseconds. */
  advance(ms: number): void {
    this._now += ms;
  }

  /** Set the fake clock to an absolute time. */
  set(ms: number): void {
    this._now = ms;
  }
}
