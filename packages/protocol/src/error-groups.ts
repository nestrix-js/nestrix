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

/**
 * The stored triage state of a group (issue #26, standalone server only). Decided by people and by
 * regression detection, kept apart from the computed {@link ErrorGroupState}, which is a view of
 * the window. How the two relate:
 * - `open`: nothing was decided (a group the server has not stored yet is open as well). The
 *   computed state still says new, ongoing or quiet.
 * - `resolved`: marked fixed; it stays resolved while it is not seen again, or only in the release
 *   it was resolved in.
 * - `regressed`: resolved, then seen again after the resolution, in another release (or in any
 *   release, when the release it was resolved in or the occurrence's release is unknown). Stored:
 *   it stays until someone resolves, ignores or reopens it. The computed `regressed` only means
 *   "back after a day or a release" within the window and can be true for a group nobody resolved.
 * - `ignored`: left out of the group list by default, of counts and of alerts, until reopened.
 */
export type ErrorGroupTriageState =
  | "open"
  | "resolved"
  | "regressed"
  | "ignored";

export interface ErrorGroupTriage {
  state: ErrorGroupTriageState;
  /** When it was resolved; absent unless the state is `resolved` or `regressed`. */
  resolvedAtUnixMs?: number;
  /** The release of the group's latest occurrence at that time, when known. */
  resolvedInRelease?: string;
  /** When the latest regression was detected (the time of the occurrence that caused it). */
  regressedAtUnixMs?: number;
  /** When it was ignored; absent unless the state is `ignored`. */
  ignoredAtUnixMs?: number;
}

/**
 * `POST api/v1/errors/groups/resolve|ignore|reopen` (standalone server, admin session only).
 * `key` is `ErrorGroup.key`. Without `service` the action applies to the group in every service
 * that has it; with one, to that service only.
 */
export interface ErrorGroupTriageRequest {
  key: string;
  service?: string;
  /**
   * The environment (issue #28, D-101): absent acts on the group in every environment, `unset` on
   * the copy without one, any other value on that environment's. A group is triaged per service
   * and environment.
   */
  environment?: string;
}

export interface ErrorGroupTriageResponse {
  /** Stored groups changed. */
  updated: number;
  /** The group's state afterwards, the way a list reports it. */
  triage: ErrorGroupTriage;
}

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
  /**
   * The stored triage state. Sent by the standalone server only (it is also how a client knows
   * the triage routes exist); absent from the embedded dashboard and from older servers. Over
   * several services the state is the group's across all of them: `regressed` if any service's
   * copy regressed, else `open` if any is open, else `resolved` if any is, else `ignored`.
   */
  triage?: ErrorGroupTriage;
}

export interface ErrorGroupsResponse {
  windowMinutes: number;
  /**
   * Width of one `series` bucket: 60,000 for the 15-minute window, 300,000 up to 6 hours, one hour
   * up to 7 days and one day above (the standalone server's longer windows).
   */
  bucketMs: number;
  /** Standalone server: true when the range holds more error occurrences than the server reads; the newest were grouped. */
  truncated?: boolean;
  fromUnixMs: number;
  toUnixMs: number;
  /** Most occurrences first, at most 100. */
  groups: ErrorGroup[];
  /**
   * Groups left out because they are ignored (the default view; `triage=ignored` or `triage=all`
   * lists them). Standalone server only.
   */
  ignoredCount?: number;
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
