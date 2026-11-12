/** A time range in Unix milliseconds, both ends inclusive. */
export interface TimeRange {
  fromUnixMs: number;
  toUnixMs: number;
}

/**
 * The range covering the buckets that contain `fromMs` and `toMs` (any order), clamped to the
 * `count` buckets that start at `firstUnixMs`. Each bucket is `bucketMs` wide and its end is
 * inclusive of the last millisecond before the next bucket.
 */
export function rangeOfBuckets(
  fromMs: number,
  toMs: number,
  firstUnixMs: number,
  bucketMs: number,
  count: number,
): TimeRange {
  const index = (ms: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((ms - firstUnixMs) / bucketMs)));
  const lo = index(Math.min(fromMs, toMs));
  const hi = index(Math.max(fromMs, toMs));
  return {
    fromUnixMs: firstUnixMs + lo * bucketMs,
    toUnixMs: firstUnixMs + (hi + 1) * bucketMs - 1,
  };
}

/** "10:02" for a Unix time in the viewer's time zone. */
export function formatClock(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
