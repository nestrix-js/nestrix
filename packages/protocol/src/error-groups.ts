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
}

export interface ErrorGroupsResponse {
  windowMinutes: number;
  /** 60,000 for the 15-minute window, 300,000 for the 60-minute one. */
  bucketMs: number;
  fromUnixMs: number;
  toUnixMs: number;
  /** Most occurrences first, at most 100. */
  groups: ErrorGroup[];
}
