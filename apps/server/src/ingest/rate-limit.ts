/**
 * Token bucket per principal (API key, or client address with auth off). One token per export
 * request. Buckets live in a bounded map: keys are few, but addresses are not.
 */
import type { IngestRateLimit } from "../config.js";

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export type RateDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  static readonly MAX_BUCKETS = 10_000;
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: IngestRateLimit,
    private readonly now: () => number = () => performance.now(),
  ) {}

  take(principal: string): RateDecision {
    const now = this.now();
    let bucket = this.buckets.get(principal);
    if (bucket === undefined) {
      bucket = { tokens: this.limit.burst, updatedMs: now };
    } else {
      this.buckets.delete(principal); // Re-inserted below: the map stays in least-recent-first order.
      const elapsed = Math.max(0, now - bucket.updatedMs) / 1000;
      bucket.tokens = Math.min(
        this.limit.burst,
        bucket.tokens + elapsed * this.limit.requestsPerSecond,
      );
      bucket.updatedMs = now;
    }
    this.buckets.set(principal, bucket);
    if (this.buckets.size > RateLimiter.MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    const seconds = (1 - bucket.tokens) / this.limit.requestsPerSecond;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
  }
}
