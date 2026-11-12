/**
 * Error groups (P9-04): error occurrences grouped by (error type, normalised message, route).
 * Pure functions. `packages/nestjs/src/store/error-groups.ts` is the embedded copy
 * (the server cannot import this package's internals); keep the two in step, both have the same
 * unit tests.
 */
import type {
  ErrorGroup,
  ErrorGroupOccurrence,
  ErrorGroupRelease,
  ErrorGroupState,
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
  /** `service.version` of the trace's resource (P15-02). */
  readonly release?: string | undefined;
}

const MAX_PATTERN = 300;
const MAX_GROUPS = 100;
const MAX_RECENT = 10;
const MAX_RELEASES = 5;
/** A group absent for this long before its first occurrence in the window is a regression. */
export const REGRESSION_GAP_MS = 24 * 3_600_000;

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
  releases: Map<string, number>;
  /** The group's earliest occurrence inside the window, and its release. */
  firstMs: number;
  firstRelease: string | undefined;
}

/** What is known of a group from before the window (P15-02). */
interface Before {
  firstMs: number;
  lastMs: number;
}

/** The oldest and the newest occurrence of a group that carries a release. */
interface Ends {
  firstMs: number;
  firstRelease: string;
  lastMs: number;
  lastRelease: string;
}

/**
 * A group's state (see `ErrorGroupState`). First match wins:
 * 1. `quiet`: its last occurrence is before the window's last two buckets.
 * 2. `new`: nothing stored before the window.
 * 3. `regressed`: seen before the window, and between the last of those and its first occurrence
 *    inside the window either at least 24 hours passed, or a release was first seen (a release
 *    the group's first in-window occurrence is not in): it skipped a whole release.
 * 4. `ongoing`.
 * `releaseFirstSeen` is when each release first showed up in the stored occurrences.
 */
export function stateOf(input: {
  before: { lastMs: number } | undefined;
  firstInWindowMs: number;
  firstInWindowRelease: string | undefined;
  lastMs: number;
  toUnixMs: number;
  bucketMs: number;
  releaseFirstSeen: ReadonlyMap<string, number>;
}): ErrorGroupState {
  if (input.lastMs < input.toUnixMs - 2 * input.bucketMs) return "quiet";
  const before = input.before;
  if (before === undefined) return "new";
  if (input.firstInWindowMs - before.lastMs >= REGRESSION_GAP_MS)
    return "regressed";
  for (const [release, firstMs] of input.releaseFirstSeen) {
    if (
      release !== input.firstInWindowRelease &&
      firstMs > before.lastMs &&
      firstMs < input.firstInWindowMs
    )
      return "regressed";
  }
  return "ongoing";
}

/**
 * Groups the occurrences that fall in the window ending at `now`. Groups come most occurrences
 * first, then most recent first, at most 100. Occurrences before the window do not make groups;
 * they give the groups of the window their history: first seen ever, `state`, releases (P15-02).
 * `historyFromUnixMs` is the start of the history the caller read (default: the oldest
 * occurrence given); it is reported as `history`.
 */
export function groupErrors(
  occurrences: Iterable<ErrorOccurrence>,
  windowMinutes: number,
  now: number,
  historyFromUnixMs?: number,
): ErrorGroupsResponse {
  const { bucketMs, count: buckets } = bucketsOf(windowMinutes);
  const fromUnixMs = (Math.floor(now / bucketMs) - buckets + 1) * bucketMs;
  const groups = new Map<string, Acc>();
  const before = new Map<string, Before>();
  const ends = new Map<string, Ends>();
  const releaseFirstSeen = new Map<string, number>();
  let oldest = fromUnixMs;
  for (const o of occurrences) {
    if (o.timeUnixMs > now + bucketMs) continue;
    if (o.timeUnixMs < oldest) oldest = o.timeUnixMs;
    const pattern = o.message === undefined ? "" : normaliseMessage(o.message);
    const key = JSON.stringify([o.errorType ?? null, pattern, o.route ?? null]);
    if (o.release !== undefined) {
      const seen = releaseFirstSeen.get(o.release);
      if (seen === undefined || o.timeUnixMs < seen)
        releaseFirstSeen.set(o.release, o.timeUnixMs);
      const e = ends.get(key);
      if (e === undefined) {
        ends.set(key, {
          firstMs: o.timeUnixMs,
          firstRelease: o.release,
          lastMs: o.timeUnixMs,
          lastRelease: o.release,
        });
      } else {
        if (o.timeUnixMs < e.firstMs) {
          e.firstMs = o.timeUnixMs;
          e.firstRelease = o.release;
        }
        if (o.timeUnixMs >= e.lastMs) {
          e.lastMs = o.timeUnixMs;
          e.lastRelease = o.release;
        }
      }
    }
    if (o.timeUnixMs < fromUnixMs) {
      const b = before.get(key);
      if (b === undefined) {
        before.set(key, { firstMs: o.timeUnixMs, lastMs: o.timeUnixMs });
      } else {
        if (o.timeUnixMs < b.firstMs) b.firstMs = o.timeUnixMs;
        if (o.timeUnixMs > b.lastMs) b.lastMs = o.timeUnixMs;
      }
      continue;
    }
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
      acc = {
        group,
        services: new Set(),
        latest: o,
        releases: new Map(),
        firstMs: o.timeUnixMs,
        firstRelease: o.release,
      };
      groups.set(key, acc);
    }
    if (o.timeUnixMs < acc.firstMs) {
      acc.firstMs = o.timeUnixMs;
      acc.firstRelease = o.release;
    }
    if (o.release !== undefined)
      acc.releases.set(o.release, (acc.releases.get(o.release) ?? 0) + 1);
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
  for (const [key, acc] of groups) {
    const { group, services, latest } = acc;
    trimRecent(group);
    group.services = [...services].sort();
    group.exampleTraceId = latest.traceId;
    if (latest.message !== undefined) group.latestMessage = latest.message;
    const b = before.get(key);
    group.firstEverUnixMs = Math.min(
      b?.firstMs ?? Infinity,
      group.firstSeenUnixMs,
    );
    group.lastEverUnixMs = group.lastSeenUnixMs;
    const e = ends.get(key);
    if (e !== undefined) {
      group.firstSeenRelease = e.firstRelease;
      group.lastSeenRelease = e.lastRelease;
    }
    if (acc.releases.size > 0) {
      group.releases = [...acc.releases]
        .map(([release, count]): ErrorGroupRelease => ({ release, count }))
        .sort((x, y) => y.count - x.count || (x.release < y.release ? -1 : 1))
        .slice(0, MAX_RELEASES);
    }
    group.state = stateOf({
      before: b,
      firstInWindowMs: acc.firstMs,
      firstInWindowRelease: acc.firstRelease,
      lastMs: group.lastSeenUnixMs,
      toUnixMs: now,
      bucketMs,
      releaseFirstSeen,
    });
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
    history: {
      fromUnixMs: Math.min(historyFromUnixMs ?? oldest, oldest),
      toUnixMs: now,
    },
  };
}

function trimRecent(group: ErrorGroup): void {
  group.recent.sort((a, b) => b.timeUnixMs - a.timeUnixMs);
  if (group.recent.length > MAX_RECENT) group.recent.length = MAX_RECENT;
}
