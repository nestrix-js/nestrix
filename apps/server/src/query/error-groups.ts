/**
 * Error groups (P9-04): error occurrences grouped by (error type, normalised message, route).
 * Pure functions. `packages/nestjs/src/store/error-groups.ts` is the embedded copy
 * (the server cannot import this package's internals); keep the two in step, both have the same
 * unit tests.
 */
import type {
  ErrorGroup,
  ErrorGroupOccurrence,
  ErrorGroupsResponse,
} from "@nestrix-js/protocol";

/** One error occurrence, whichever backend it came from. */
export interface ErrorOccurrence {
  readonly traceId: string;
  readonly spanId: string;
  readonly timeUnixMs: number;
  readonly errorType?: string | undefined;
  readonly message?: string | undefined;
  readonly route?: string | undefined;
  readonly service?: string | undefined;
}

const MAX_PATTERN = 300;
const MAX_GROUPS = 100;
const MAX_RECENT = 10;

// Order matters: quoted strings first (they may hold the other kinds), then the shaped ids, then
// bare numbers. The opening quote must not follow a word character, so "user's id isn't set"
// does not count `'s id isn'` as a quoted string.
const QUOTED = /(?<![\p{L}\p{N}_])(["'`])(?:(?!\1)[^\n]){0,200}\1/gu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi;
// Hex ids need a digit and a letter, so "deadbeef" words and plain numbers stay separate.
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
// A number may touch a unit ("250ms", "3.5s") but not follow a letter ("id42", "utf8").
const NUMBER = /(?<![\p{L}_\d])\d+(?:\.\d+)?/gu;

/**
 * Replaces what varies between occurrences of one error: "user 42 not found" and "user 7 not
 * found" both become "user <n> not found".
 */
export function normaliseMessage(message: string): string {
  const out = message
    .replace(QUOTED, "<str>")
    .replace(EMAIL, "<email>")
    .replace(UUID, "<uuid>")
    .replace(HEX_PREFIXED, "<hex>")
    .replace(HEX_ID, "<hex>")
    .replace(NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > MAX_PATTERN ? `${out.slice(0, MAX_PATTERN)}...` : out;
}

/** Bucket size and count of a window: one minute for 15 minutes, five minutes for 60. */
function bucketsOf(windowMinutes: number): { bucketMs: number; count: number } {
  const bucketMs = windowMinutes <= 15 ? 60_000 : 300_000;
  return { bucketMs, count: Math.ceil((windowMinutes * 60_000) / bucketMs) };
}

interface Acc {
  group: ErrorGroup;
  services: Set<string>;
  latest: ErrorOccurrence;
}

/**
 * Groups the occurrences that fall in the window ending at `now`. Occurrences outside it are
 * ignored. Groups come most occurrences first, then most recent first, at most 100.
 */
export function groupErrors(
  occurrences: Iterable<ErrorOccurrence>,
  windowMinutes: number,
  now: number,
): ErrorGroupsResponse {
  const { bucketMs, count: buckets } = bucketsOf(windowMinutes);
  const fromUnixMs = (Math.floor(now / bucketMs) - buckets + 1) * bucketMs;
  const groups = new Map<string, Acc>();
  for (const o of occurrences) {
    if (o.timeUnixMs < fromUnixMs || o.timeUnixMs > now + bucketMs) continue;
    const pattern = o.message === undefined ? "" : normaliseMessage(o.message);
    const key = JSON.stringify([o.errorType ?? null, pattern, o.route ?? null]);
    let acc = groups.get(key);
    if (acc === undefined) {
      const group: ErrorGroup = {
        key,
        pattern,
        count: 0,
        firstSeenUnixMs: o.timeUnixMs,
        lastSeenUnixMs: o.timeUnixMs,
        series: new Array<number>(buckets).fill(0),
        services: [],
        exampleTraceId: o.traceId,
        recent: [],
      };
      if (o.errorType !== undefined) group.errorType = o.errorType;
      if (o.route !== undefined) group.route = o.route;
      acc = { group, services: new Set(), latest: o };
      groups.set(key, acc);
    }
    const g = acc.group;
    g.count++;
    const index = Math.min(
      buckets - 1,
      Math.floor((o.timeUnixMs - fromUnixMs) / bucketMs),
    );
    g.series[index] = (g.series[index] ?? 0) + 1;
    if (o.timeUnixMs < g.firstSeenUnixMs) g.firstSeenUnixMs = o.timeUnixMs;
    if (o.timeUnixMs >= g.lastSeenUnixMs) {
      g.lastSeenUnixMs = o.timeUnixMs;
      acc.latest = o;
    }
    if (o.service !== undefined) acc.services.add(o.service);
    const entry: ErrorGroupOccurrence = {
      traceId: o.traceId,
      spanId: o.spanId,
      timeUnixMs: o.timeUnixMs,
    };
    if (o.message !== undefined) entry.message = o.message;
    if (o.service !== undefined) entry.service = o.service;
    g.recent.push(entry);
    // Keep the working set small: the newest few only.
    if (g.recent.length > MAX_RECENT * 4) trimRecent(g);
  }
  const result: ErrorGroup[] = [];
  for (const { group, services, latest } of groups.values()) {
    trimRecent(group);
    group.services = [...services].sort();
    group.exampleTraceId = latest.traceId;
    if (latest.message !== undefined) group.latestMessage = latest.message;
    result.push(group);
  }
  result.sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeenUnixMs - a.lastSeenUnixMs ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    windowMinutes,
    bucketMs,
    fromUnixMs,
    toUnixMs: now,
    groups: result.slice(0, MAX_GROUPS),
  };
}

function trimRecent(group: ErrorGroup): void {
  group.recent.sort((a, b) => b.timeUnixMs - a.timeUnixMs);
  if (group.recent.length > MAX_RECENT) group.recent.length = MAX_RECENT;
}
