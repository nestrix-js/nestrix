/**
 * `GET <path>/api/v1/errors/groups`: the error items of a window grouped by (error type,
 * normalised message, route). Built from the stored, sampled traces, not counted before sampling.
 */

/** One stored error occurrence of a group. */
export interface ErrorGroupOccurrence {
  traceId: string;
  spanId: string;
  timeUnixMs: number;
  /** The raw message (already scrubbed at the source). */
  message?: string;
  service?: string;
}

/**
 * Where a group stands. Computed by the backend from every stored occurrence, not only the window
 * (P15-02). Rules, first match wins:
 * - `quiet`: no occurrence in the last two buckets of the window.
 * - `new`: no stored occurrence before the window (first seen inside it).
 * - `regressed`: seen before the window, absent for at least 24 hours (or through a release first
 *   seen in between) before its first occurrence inside the window, and back.
 * - `ongoing`: everything else.
 */
export type ErrorGroupState = "new" | "regressed" | "ongoing" | "quiet";

/** Occurrences of a group in one release, within the window. */
export interface ErrorGroupRelease {
  release: string;
  count: number;
}

export interface ErrorGroup {
  /** Stable within a response; identifies the group in lists. */
  key: string;
  errorType?: string;
  /**
   * The message with numbers, UUIDs, hex ids, quoted strings and email addresses replaced by
   * `<n>`, `<uuid>`, `<hex>`, `<str>` and `<email>`; empty when the errors carry no message.
   */
  pattern: string;
  /** Route of the trace's root span, when it has one. */
  route?: string;
  /** Occurrences in the window. */
  count: number;
  firstSeenUnixMs: number;
  lastSeenUnixMs: number;
  /** Occurrences per bucket, oldest first; `ErrorGroupsResponse.bucketMs` each, ending at the window's end. */
  series: number[];
  /** Services of the occurrences, sorted. */
  services: string[];
  /** Trace of the latest occurrence. */
  exampleTraceId: string;
  /** Raw message of the latest occurrence. */
  latestMessage?: string;
  /** Newest first, at most 10. */
  recent: ErrorGroupOccurrence[];
  /** See {@link ErrorGroupState}. Absent from older backends. */
  state?: ErrorGroupState;
  /**
   * First and last occurrence over every stored occurrence (`ErrorGroupsResponse.history`), not
   * only the window's. `firstSeenUnixMs`/`lastSeenUnixMs` stay window-scoped.
   */
  firstEverUnixMs?: number;
  lastEverUnixMs?: number;
  /** Release (`service.version`) of the oldest and the newest stored occurrence that has one. */
  firstSeenRelease?: string;
  lastSeenRelease?: string;
  /** Occurrences in the window per release, most first, at most 5. */
  releases?: ErrorGroupRelease[];
}

export interface ErrorGroupsResponse {
  windowMinutes: number;
  /** 60,000 for the 15-minute window, 300,000 for the 60-minute one. */
  bucketMs: number;
  fromUnixMs: number;
  toUnixMs: number;
  /** Most occurrences first, at most 100. */
  groups: ErrorGroup[];
  /**
   * The span of stored history `state`, `firstEver*` and the releases were computed over: the
   * server reads up to 7 days, the embedded store whatever it still holds.
   */
  history?: { fromUnixMs: number; toUnixMs: number };
}

/** One release in {@link ErrorInsightsResponse}. */
export interface ErrorReleaseStat {
  release: string;
  /** Error events in the range. */
  events: number;
  /** Requests (traces with an HTTP root) in the range; absent when the backend cannot count them. */
  requests?: number;
  /** `events / requests * 1000`; absent without requests. */
  per1000Requests?: number;
  /** First stored trace or error of the release. */
  firstSeenUnixMs: number;
}

/**
 * `GET <path>/api/v1/errors/insights`: error events by weekday and hour (UTC) and per release over
 * the last 7 days, or what the store holds. Counts every error event, not groups.
 */
export interface ErrorInsightsResponse {
  /** The range asked for: 7 days ending now. */
  fromUnixMs: number;
  toUnixMs: number;
  /** Where stored data actually starts inside the range (the embedded store keeps hours, not days). */
  coveredFromUnixMs: number;
  zone: "UTC";
  /** 7 rows, Monday to Sunday, of 24 hourly counts (0 to 23, UTC). */
  heatmap: number[][];
  total: number;
  /** The newest releases (at most 8), oldest first. */
  releases: ErrorReleaseStat[];
}
