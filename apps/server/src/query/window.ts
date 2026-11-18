/**
 * Time ranges of the aggregate query routes (issue #29, D-107).
 *
 * Every aggregate route takes either `windowMinutes` (15, 60, 360, 1440, 10080 or 43200, within the
 * retention) or `fromUnixMs` and `toUnixMs` (both). {@link resolveWindow} turns either into the
 * pair the services work with: a window length in minutes and the instant it ends. A range is
 * widened to whole buckets, so a service never has to know which of the two was asked for. The
 * previous window of every view is "the same length, just before", whichever way the window was
 * asked for.
 *
 * Bucket width grows with the length: see {@link bucketMsFor}.
 */
import { HttpException } from "@nestjs/common";
import type { ApiError } from "@nestrix-js/protocol";
import type { Values } from "./params.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** How far past the server's clock a range may end (clients' clocks differ). */
export const MAX_FUTURE_MS = 5 * MINUTE_MS;

/** Standalone windows in minutes, shortest first (the protocol's `STANDALONE_WINDOW_MINUTES`). */
export const WINDOW_OPTIONS: readonly number[] = [
  15, 60, 360, 1440, 10_080, 43_200,
];

/**
 * Width of one bucket of a window of `windowMinutes`:
 *
 * | window | bucket |
 * |---|---|
 * | up to 15 min | 1 min |
 * | up to 60 min | 1 min (`fine`: the rollup views, whose series were per minute) or 5 min |
 * | up to 6 h | 5 min |
 * | up to 7 d | 1 h |
 * | longer | 1 day (UTC) |
 *
 * `fine` is true for the views read from the minute rollups (routes, overview) and false for the
 * ones read from stored spans (timeline, dependencies, error groups), which keep 5 minutes at 60.
 */
export function bucketMsFor(windowMinutes: number, fine = false): number {
  if (windowMinutes <= 15) return MINUTE_MS;
  if (windowMinutes <= 60) return fine ? MINUTE_MS : 5 * MINUTE_MS;
  if (windowMinutes <= 360) return 5 * MINUTE_MS;
  if (windowMinutes <= 10_080) return HOUR_MS;
  return DAY_MS;
}

/** The window the rollup views read: whole buckets ending at the bucket that holds `now`. */
export interface Window {
  /** Minute index (Unix ms / 60 000) of the first and last minute of the window. */
  first: number;
  last: number;
  fromMs: number;
  toMs: number;
  bucketMs: number;
  /** Number of buckets (the last may be partial). */
  buckets: number;
}

/**
 * `windowMinutes` ending at `now`, aligned to buckets of `bucketMs`: with one-minute buckets the
 * last `windowMinutes` minutes; with longer ones the buckets that cover that many minutes, the
 * last one the bucket `now` is in (so a 24 hour window read at 12:20 starts at 13:00 the day
 * before and holds 23 to 24 hours).
 */
export function windowOf(
  windowMinutes: number,
  now: number,
  bucketMs: number = MINUTE_MS,
): Window {
  const buckets = Math.ceil((windowMinutes * MINUTE_MS) / bucketMs);
  const firstBucket = Math.floor(now / bucketMs) - buckets + 1;
  const fromMs = firstBucket * bucketMs;
  return {
    first: fromMs / MINUTE_MS,
    last: Math.floor(now / MINUTE_MS),
    fromMs,
    toMs: now,
    bucketMs,
    buckets,
  };
}

export interface ResolvedWindow {
  windowMinutes: number;
  /** The instant the window ends. */
  now: number;
}

function bad(message: string): never {
  const body: ApiError = { error: { code: "bad_request", message } };
  throw new HttpException(body, 400);
}

const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * Reads `windowMinutes` or `fromUnixMs` + `toUnixMs` from parsed values. Throws a 400 for: both
 * kinds together, only one of `fromUnixMs` and `toUnixMs`, `toUnixMs` not after `fromUnixMs`, a
 * span under a minute or over the retention, an end more than 5 minutes ahead of the server's
 * clock, and a `windowMinutes` longer than the retention. A range is widened to a whole number of
 * buckets (never shortened), and ends at the server's clock when it ends a little ahead of it.
 */
export function resolveWindow(
  v: Values,
  opts: {
    retentionDays: number;
    defaultWindowMinutes: number;
    now?: number;
  },
): ResolvedWindow {
  const serverNow = opts.now ?? Date.now();
  const retentionMs = opts.retentionDays * DAY_MS;
  const given = (name: string) => v[name] !== undefined;
  const hasRange = given("fromUnixMs") || given("toUnixMs");
  if (hasRange && given("windowMinutes")) {
    bad(
      'Query parameters "windowMinutes" and "fromUnixMs" / "toUnixMs" cannot be used together.',
    );
  }
  if (!hasRange) {
    const windowMinutes =
      typeof v.windowMinutes === "number"
        ? v.windowMinutes
        : opts.defaultWindowMinutes;
    if (windowMinutes * MINUTE_MS > retentionMs) {
      bad(
        `Query parameter "windowMinutes" is longer than the retention of ${days(opts.retentionDays)}.`,
      );
    }
    return { windowMinutes, now: serverNow };
  }
  if (!given("fromUnixMs") || !given("toUnixMs")) {
    bad('Query parameters "fromUnixMs" and "toUnixMs" must be given together.');
  }
  const from = Number(v.fromUnixMs);
  const to = Number(v.toUnixMs);
  if (to <= from) {
    bad('Query parameter "toUnixMs" must be after "fromUnixMs".');
  }
  if (to - from < MINUTE_MS) {
    bad(
      'The range between "fromUnixMs" and "toUnixMs" must be at least a minute.',
    );
  }
  if (to - from > retentionMs) {
    bad(
      `The range between "fromUnixMs" and "toUnixMs" is longer than the retention of ${days(opts.retentionDays)}.`,
    );
  }
  if (to > serverNow + MAX_FUTURE_MS) {
    bad('Query parameter "toUnixMs" is too far in the future.');
  }
  const end = Math.min(to, serverNow);
  // Whole buckets that hold both ends; the bucket width depends on the length, so repeat until
  // the length and the width agree (the width never shrinks as the length grows).
  let windowMinutes = Math.max(
    1,
    Math.floor(end / MINUTE_MS) - Math.floor(from / MINUTE_MS) + 1,
  );
  for (let i = 0; i < 8; i++) {
    const bucket = bucketMsFor(windowMinutes);
    const needed = Math.floor(end / bucket) - Math.floor(from / bucket) + 1;
    const widened = (needed * bucket) / MINUTE_MS;
    const settled = bucketMsFor(widened) === bucket;
    windowMinutes = widened;
    if (settled) break;
  }
  return { windowMinutes, now: end };
}

/** The windows a server with `retentionDays` offers (`MetaResponse.statistics.windowMinutesOptions`). */
export function windowOptionsFor(retentionDays: number): number[] {
  return WINDOW_OPTIONS.filter((w) => w * MINUTE_MS <= retentionDays * DAY_MS);
}
