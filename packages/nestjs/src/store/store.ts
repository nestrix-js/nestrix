/**
 * The dashboard's in-memory trace store (architecture §4.6, backlog P2-03): one per
 * process, created on first need by the setup code or by `nestrixSpanProcessor()`.
 *
 * Request path. `enqueue` (called from the span processor's `onEnd`, inside host code
 * for every recording span) only pushes the span onto a bounded queue and schedules one
 * drain per batch with `setImmediate`. Conversion, redaction (D-37) and insertion happen
 * in the drain. Nothing here throws to a caller.
 *
 * Closed by default. The store accepts spans only while at least one Nestrix app with
 * the dashboard on is attached (`attach`); until then, and after the last detaches,
 * `enqueue` ignores spans. A host that adds `nestrixSpanProcessor()` to its own provider
 * while the dashboard is off therefore stores nothing.
 *
 * Shape. Spans are grouped by trace id. A trace becomes listed (gets a sequence number
 * and appears in the trace list) when its first local-root candidate ends: a span with
 * no parent, or whose parent is remote (`parentSpanContext.isRemote`, which is how an
 * incoming `traceparent` arrives). Spans ending later are appended to the same trace
 * and change its span count, not its place in the list. The summary's root is the
 * earliest-starting candidate whose parent is not in the trace (`chooseRoot`), and it
 * follows the true root when that arrives later.
 *
 * Eviction. Bounded by `maxTraces` (listed or not) and by approximate bytes
 * (`record.ts`). The trace whose first span arrived earliest is evicted first, with its
 * error items. A late span of an evicted trace starts a new, unlisted entry that is
 * evicted in turn; a span estimated larger than `maxBytes` on its own is dropped.
 */
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { diagnostics as processDiagnostics } from "../diagnostics.js";
import type { RedactableSpan, RedactHook } from "../options.js";
import { redactSpan } from "../otel/redaction.js";
import type { TelemetryDiagnostics } from "../otel/types.js";
import { SUPPRESS_TRACING_KEY } from "../outbound/rules.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "../privacy.js";
import { type CursorKind, decodeCursor, encodeCursor } from "./cursor.js";
import { type ErrorOccurrence, groupErrors } from "./error-groups.js";
import {
  DEFAULT_STORE_LIMITS,
  DRAIN_CHUNK,
  MAX_PENDING_SPANS,
  normaliseLimits,
  type StoreLimits,
} from "./limits.js";
import type {
  Attributes,
  ErrorGroupsResponse,
  ErrorItem,
  ErrorListResponse,
  SpanRecord,
  TraceListResponse,
  TraceResponse,
  TraceSummary,
  TraceType,
} from "./protocol-types.js";
import {
  buildRecord,
  ERROR_ITEM_BYTES,
  readIdentity,
  readResource,
  TRACE_BYTES,
} from "./record.js";

/** Nestrix's scrub step and the user's hook, as the app that attached configured them. */
export interface StoreRedaction {
  /** Defaults to Nestrix's scrub with the default redacted query keys. */
  readonly scrub?: ((span: RedactableSpan) => void) | undefined;
  readonly redact?: RedactHook | undefined;
}

export interface TraceListQuery {
  readonly limit: number;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly route?: string | undefined;
  readonly method?: string | undefined;
  readonly status?: "ok" | "error" | "4xx" | "5xx" | undefined;
  readonly minDurationMs?: number | undefined;
  /** Case-insensitive substring of any span name in the trace, or of the route. */
  readonly search?: string | undefined;
  /**
   * `TraceSummary.type`, except `job`, which matches every trace with `hasJob` (any root): a
   * request that enqueued a job appears under both `http` and `job`.
   */
  readonly type?: TraceType | undefined;
  /** Exact `service.version` of the trace's resource. */
  readonly release?: string | undefined;
  /** Exact `user.id` of the root span. */
  readonly user?: string | undefined;
}

export interface ErrorListQuery {
  readonly limit: number;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly route?: string | undefined;
}

/** Counters only grow, except the current sizes (`traces`, `spans`, `bytes`, ...). */
export interface StoreStats {
  /** Trace entries held, listed or not. */
  readonly traces: number;
  /** Of those, how many have a local root and appear in the trace list. */
  readonly listedTraces: number;
  readonly spans: number;
  readonly errorItems: number;
  /** Estimated bytes held. */
  readonly bytes: number;
  readonly maxTraces: number;
  readonly maxBytes: number;
  readonly evictedTraces: number;
  /** Sum of the five drop counters below (the query API's `droppedSpans`). */
  readonly droppedSpans: number;
  /** `onEnd` found the pending queue full. */
  readonly queueDroppedSpans: number;
  /** The `redact` hook returned `false`. */
  readonly redactDroppedSpans: number;
  /** Scrub or `redact` threw, returned a promise or left the span unusable. */
  readonly redactFailedSpans: number;
  /** Not a usable span (no valid ids or times). */
  readonly invalidSpans: number;
  /** Estimated larger than `maxBytes` on its own. */
  readonly oversizeSpans: number;
  /** Spans the drain has taken in while attached (stored or dropped). `> 0` means spans arrive. */
  readonly receivedSpans: number;
  /** `nestrixSpanProcessor()` calls (processors a host created for its own provider). */
  readonly processors: number;
  /** Apps attached now; spans are accepted only while this is above 0. */
  readonly attached: number;
}

export interface TraceStore {
  /** Random per process; carried by every cursor and the query API's `processId`. */
  readonly processId: string;
  readonly limits: StoreLimits;
  /**
   * Starts accepting spans, redacted with `redaction` (the first attached app's wins
   * while it stays attached). Returns an idempotent detach. Never throws.
   */
  attach(redaction: StoreRedaction): () => void;
  /** Called from `onEnd`: enqueue and schedule a drain. O(1), never throws. */
  enqueue(span: unknown): void;
  /** Converts and inserts everything pending now. Never throws. */
  drainNow(): void;
  /** Records a `nestrixSpanProcessor()` call, so setup knows whether to print the host hint. */
  countProcessor(): void;
  /** Newest first. Never throws on any input; a bad cursor answers `reset: true`. */
  listTraces(query: TraceListQuery): TraceListResponse;
  /** All stored spans of a trace, by start time; `undefined` when not stored. */
  getTrace(traceId: string): TraceResponse | undefined;
  listErrors(query: ErrorListQuery): ErrorListResponse;
  /** Error occurrences of the window grouped by (type, normalised message, route). */
  groupErrors(windowMinutes: number, now?: number): ErrorGroupsResponse;
  /**
   * Calls `visit` with the stored spans of each trace held (oldest first). The array is the
   * store's own: read it, do not keep or change it. Never throws; a fault in `visit` stops the scan.
   */
  scanAllTraces(visit: (spans: readonly SpanRecord[]) => void): void;
  /**
   * Calls `visit` for every listed trace (one with a local root) whose root started at or after
   * `sinceUnixMs`, oldest first. `visit` must not keep or change `spans`. Never throws.
   */
  scanTraces(
    sinceUnixMs: number,
    visit: (
      root: SpanRecord,
      spans: readonly SpanRecord[],
      resource: Attributes,
      traceId: string,
    ) => void,
  ): void;
  stats(): StoreStats;
}

interface TraceEntry {
  readonly traceId: string;
  readonly spans: SpanRecord[];
  /**
   * Span ids stored, so a span seen twice (two processors on one provider) is stored once.
   * Created only once the trace holds more than `SMALL_TRACE_SPANS` spans; before that the check scans `spans`
   * (most traces are small, and a `Set` per trace was a measurable share of the per-span cost, P2-15).
   */
  spanIds: Set<string> | undefined;
  resource: Attributes;
  bytes: number;
  /** The trace's local root (see `chooseRoot`); set once a candidate has arrived. */
  root: SpanRecord | undefined;
  /**
   * Local-root candidates: spans with no parent, or with a remote one. A candidate whose
   * parent is stored in this trace is not the root (a service calling itself over HTTP:
   * its inner server span has a remote parent, the client span, that is in the trace).
   */
  candidates: SpanRecord[];
  /** Any span stored so far is a consumer span or has `nestrix.entry = 'job'`. */
  hasJob: boolean;
  /** Position in the trace list; 0 until listed. */
  seq: number;
  dead: boolean;
  readonly errors: ErrorEntry[];
}

interface ErrorEntry {
  readonly seq: number;
  readonly trace: TraceEntry;
  /** Replaced by `RELEASED` on eviction (see `evict`). */
  span: SpanRecord;
  dead: boolean;
}

/** Stands in for the records of an evicted trace; never returned by a query. */
const RELEASED: SpanRecord = Object.freeze({
  spanId: "",
  name: "",
  kind: "internal",
  startTimeUnixMs: 0,
  durationMs: 0,
  attributes: {},
  events: [],
  status: { code: "unset" },
  links: [],
}) as SpanRecord;

interface Sequenced {
  readonly seq: number;
  dead: boolean;
}

interface Page<T> {
  items: T[];
  /** More matching items exist after the last one returned. */
  more: boolean;
  head: T | undefined;
  reset: boolean;
}

const ATTR_METHOD = "http.request.method";
const ATTR_ROUTE = "http.route";
const ATTR_STATUS = "http.response.status_code";
const ATTR_USER_ID = "user.id";
const ATTR_SERVICE_VERSION = "service.version";
/** Set by Nestrix's entry-method spans (P3-02, D-62): `job` or `scheduled`. */
const ATTR_NESTRIX_ENTRY = "nestrix.entry";

/**
 * What started a trace, from its root (backlog P3-03): `http` for a server span; `job` for a
 * consumer span or `nestrix.entry = 'job'`; `scheduled` for `nestrix.entry = 'scheduled'`;
 * otherwise `other`.
 */
export function traceTypeOf(root: SpanRecord): TraceType {
  // A `@MessagePattern` handler's SERVER span carries a messaging operation: not HTTP.
  if (
    root.kind === "server" &&
    root.attributes["messaging.operation.type"] !== undefined
  )
    return "other";
  if (root.kind === "server") return "http";
  const entry = root.attributes[ATTR_NESTRIX_ENTRY];
  if (root.kind === "consumer" || entry === "job") return "job";
  if (entry === "scheduled") return "scheduled";
  return "other";
}

function releaseOf(entry: { resource: Attributes }): string | undefined {
  const value = entry.resource[ATTR_SERVICE_VERSION];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The drain runs the user's `redact` hook, which may start spans of its own. Under this
 * context the SDK hands out non-recording spans, so a helper span never reaches a
 * processor (this one included): no feedback loop, nothing stored or exported.
 */
const SUPPRESSED = ROOT_CONTEXT.setValue(SUPPRESS_TRACING_KEY, true);

/** Captured at load so a host test's fake timers cannot stall the drain. */
const schedule: (fn: () => void) => unknown = globalThis.setImmediate;

function randomId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function stringAttr(record: SpanRecord, key: string): string | undefined {
  const value = record.attributes[key];
  return typeof value === "string" ? value : undefined;
}

/** Traces up to this many spans use a scan for the duplicate check; larger ones a `Set`. */
const SMALL_TRACE_SPANS = 8;

/**
 * The local root: the earliest-starting candidate whose parent is not stored in the
 * trace (all of them, when every candidate has a stored parent). A span that ended
 * before its parent arrived can be chosen until the parent ends; it is replaced then,
 * and the trace keeps its place in the list. Start times tie at clock resolution, so
 * the parent check, not the start time, is what keeps an inner span from the root.
 */
function chooseRoot(entry: TraceEntry): SpanRecord {
  let best: SpanRecord | undefined;
  let bestAny: SpanRecord | undefined;
  for (const c of entry.candidates) {
    if (bestAny === undefined || c.startTimeUnixMs < bestAny.startTimeUnixMs) {
      bestAny = c;
    }
    if (c.parentSpanId !== undefined && hasSpan(entry, c.parentSpanId))
      continue;
    if (best === undefined || c.startTimeUnixMs < best.startTimeUnixMs)
      best = c;
  }
  return (best ?? bestAny) as SpanRecord;
}

function hasSpan(entry: TraceEntry, spanId: string): boolean {
  if (entry.spanIds !== undefined) return entry.spanIds.has(spanId);
  for (const span of entry.spans) if (span.spanId === spanId) return true;
  return false;
}

function statusCodeOf(record: SpanRecord): number | undefined {
  const value = record.attributes[ATTR_STATUS];
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) ? n : undefined;
}

/**
 * The error definition (backlog "Public API"): the span's status code is `error`. An
 * exception event alone (a thrown 4xx) is not an error.
 */
function isErrorSpan(record: SpanRecord): boolean {
  return record.status.code === "error";
}

/**
 * Depth of each span in its trace: 0 when its parent is not among `spans` (a root or a
 * remote parent), else its parent's depth plus one. A parent cycle (only possible with
 * forged ids) stops at the span where it is detected.
 */
function depthsOf(spans: readonly SpanRecord[]): Map<SpanRecord, number> {
  const byId = new Map<string, SpanRecord>();
  for (const span of spans) byId.set(span.spanId, span);
  const depths = new Map<SpanRecord, number>();
  for (const span of spans) {
    const chain: SpanRecord[] = [];
    const onChain = new Set<SpanRecord>();
    let current: SpanRecord | undefined = span;
    let base = 0;
    while (current !== undefined) {
      const known = depths.get(current);
      if (known !== undefined) {
        base = known + 1;
        break;
      }
      if (onChain.has(current)) break;
      chain.push(current);
      onChain.add(current);
      current =
        current.parentSpanId === undefined
          ? undefined
          : byId.get(current.parentSpanId);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      depths.set(chain[i] as SpanRecord, base++);
    }
  }
  return depths;
}

/** Index of the item with `seq` in an array sorted by `seq`, or -1. */
function indexOfSeq(items: readonly Sequenced[], seq: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const s = (items[mid] as Sequenced).seq;
    if (s === seq) return mid;
    if (s < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * One page, newest first, over `items` (ascending by `seq`, dead ones not yet compacted).
 *
 * - No cursor: the newest `limit` matches.
 * - `before`: matches older than the cursor's item. `reset` when that item is no longer
 *   stored (evicted) or the cursor is another process's; the page then starts from the newest.
 * - `after`: matches newer than the cursor, for polling. `reset` when the cursor is
 *   unusable (another process's, malformed, or its item evicted), or when more than
 *   `limit` items match (a gap); the page is then the newest `limit` matches. A newer
 *   item that was evicted is not a reset: the client cannot see it either way.
 */
function page<T extends Sequenced>(
  items: readonly T[],
  query: {
    limit: number;
    before?: string | undefined;
    after?: string | undefined;
  },
  decode: (cursor: string) => number | undefined,
  matches: (item: T) => boolean,
): Page<T> {
  const limit = Math.max(1, Math.floor(query.limit) || 1);
  let head: T | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T;
    if (!item.dead) {
      head = item;
      break;
    }
  }
  /** Live matches from index `from` down to `to`, at most `limit`, and whether more follow. */
  const collect = (from: number, to: number): { out: T[]; more: boolean } => {
    const out: T[] = [];
    for (let i = from; i >= to; i--) {
      const item = items[i] as T;
      if (item.dead || !matches(item)) continue;
      if (out.length === limit) return { out, more: true };
      out.push(item);
    }
    return { out, more: false };
  };
  if (query.before !== undefined) {
    const seq = decode(query.before);
    const index = seq === undefined ? -1 : indexOfSeq(items, seq);
    if (index !== -1 && !(items[index] as T).dead) {
      const { out, more } = collect(index - 1, 0);
      return { items: out, more, head, reset: false };
    }
  } else if (query.after !== undefined) {
    const seq = decode(query.after);
    const index = seq === undefined ? -1 : indexOfSeq(items, seq);
    if (index !== -1 && !(items[index] as T).dead) {
      // Everything after the cursor's item is newer.
      const { out, more } = collect(items.length - 1, index + 1);
      // A poll answers only what is new; "load older" is the client's own state.
      if (!more) return { items: out, more: false, head, reset: false };
      // More new items than one page: the poller cannot catch up without a gap.
    }
  }
  // No cursor, or one that cannot be continued: the newest page.
  const reset = query.before !== undefined || query.after !== undefined;
  const { out, more } = collect(items.length - 1, 0);
  return { items: out, more, head, reset };
}

class Store implements TraceStore {
  readonly processId = randomId();
  limits: StoreLimits;
  limitsExplicit: boolean;

  private readonly diagnostics: TelemetryDiagnostics;
  private readonly attachments: StoreRedaction[] = [];
  private pending: unknown[] = [];
  private scheduled = false;
  private defaultScrub: ((span: RedactableSpan) => void) | undefined;

  /** Insertion order is eviction order: the trace whose first span arrived earliest goes first. */
  private readonly traces = new Map<string, TraceEntry>();
  /**
   * The same entries as `traces`, in the same order, as an array with a moving head. Taking
   * the oldest from a `Map` (`values().next()`) scans every deleted slot in front of it until
   * V8 rehashes, which cost about 40% of the store's time per span once the store was full
   * (P2-15); the array head is O(1). An entry leaves both only in `evict`.
   */
  private order: (TraceEntry | undefined)[] = [];
  private orderHead = 0;
  private listed: TraceEntry[] = [];
  private errors: ErrorEntry[] = [];
  private deadListed = 0;
  private deadErrors = 0;
  private traceSeq = 0;
  private errorSeq = 0;

  private bytes = 0;
  private spanCount = 0;
  private evictedTraces = 0;
  private queueDropped = 0;
  private redactDropped = 0;
  private redactFailed = 0;
  private invalid = 0;
  private oversize = 0;
  private received = 0;
  private processors = 0;

  constructor(
    limits: StoreLimits,
    explicit: boolean,
    diagnostics: TelemetryDiagnostics,
  ) {
    this.limits = limits;
    this.limitsExplicit = explicit;
    this.diagnostics = diagnostics;
  }

  attach(redaction: StoreRedaction): () => void {
    const token: StoreRedaction = {
      scrub: redaction?.scrub,
      redact: redaction?.redact,
    };
    try {
      this.attachments.push(token);
    } catch (error) {
      this.diagnostics.countFailure("store.attach", error);
    }
    let detached = false;
    return () => {
      try {
        if (detached) return;
        detached = true;
        const index = this.attachments.indexOf(token);
        if (index !== -1) this.attachments.splice(index, 1);
        if (this.attachments.length === 0) this.pending = [];
      } catch (error) {
        this.diagnostics.countFailure("store.detach", error);
      }
    };
  }

  countProcessor(): void {
    this.processors++;
  }

  enqueue(span: unknown): void {
    try {
      if (this.attachments.length === 0) return;
      if (this.pending.length >= MAX_PENDING_SPANS) {
        this.queueDropped++;
        return;
      }
      this.pending.push(span);
      if (!this.scheduled) {
        this.scheduled = true;
        schedule(this.onImmediate);
      }
    } catch (error) {
      this.diagnostics.countFailure("store.enqueue", error);
    }
  }

  private readonly onImmediate = (): void => {
    try {
      this.scheduled = false;
      context.with(SUPPRESSED, () => this.drainChunk(DRAIN_CHUNK));
      if (this.pending.length > 0 && !this.scheduled) {
        this.scheduled = true;
        schedule(this.onImmediate);
      }
    } catch (error) {
      // An immediate that throws would be an uncaughtException in the host.
      this.diagnostics.countFailure("store.drain", error);
    }
  };

  drainNow(): void {
    try {
      // Bounded to what is pending now: a span that arrives meanwhile waits for its own drain.
      context.with(SUPPRESSED, () => {
        let remaining = this.pending.length;
        while (remaining > 0 && this.pending.length > 0) {
          const taken = this.drainChunk(Math.min(remaining, DRAIN_CHUNK));
          remaining -= taken;
        }
      });
    } catch (error) {
      this.diagnostics.countFailure("store.drain", error);
    }
  }

  /** Ingests up to `max` pending spans, oldest first; returns how many it took. */
  private drainChunk(max: number): number {
    let batch: unknown[];
    if (this.pending.length <= max) {
      batch = this.pending;
      this.pending = [];
    } else {
      batch = this.pending.splice(0, max);
    }
    for (const span of batch) this.ingest(span);
    return batch.length;
  }

  private currentScrub(): (span: RedactableSpan) => void {
    const attached = this.attachments[0]?.scrub;
    if (attached) return attached;
    if (!this.defaultScrub) {
      const keys = buildRedactedQueryKeys();
      this.defaultScrub = (span) => scrubSpanAttributes(span, keys);
    }
    return this.defaultScrub;
  }

  /** One span, start to end. Catches everything; each failure is counted. */
  private ingest(span: unknown): void {
    const redaction = this.attachments[0];
    if (redaction === undefined) return; // Detached since it was queued.
    this.received++;
    let identity: ReturnType<typeof readIdentity>;
    try {
      identity = readIdentity(span);
    } catch (error) {
      this.invalid++;
      this.diagnostics.countFailure("store.span", error);
      return;
    }
    let result: ReturnType<typeof redactSpan>;
    try {
      result = redactSpan(span as Parameters<typeof redactSpan>[0], {
        scrub: this.currentScrub(),
        redact: redaction.redact,
        diagnostics: this.diagnostics,
      });
    } catch (error) {
      result = { outcome: "fail", error };
    }
    if (result.outcome === "fail") {
      // Fail closed, as the exporter does: a span whose redaction did not finish is not stored.
      this.redactFailed++;
      this.diagnostics.countFailure("store.redact", result.error);
      return;
    }
    if (result.outcome === "drop") {
      this.redactDropped++;
      return;
    }
    try {
      const built = buildRecord(span, identity, result);
      if (built.bytes > this.limits.maxBytes) {
        this.oversize++;
        this.diagnostics.logOnce(
          "store.oversize",
          `A span was larger than the dashboard store's whole byte limit (store.maxBytes, ${this.limits.maxBytes}) and was not stored.`,
        );
        return;
      }
      this.insert(span, identity, built.record, built.bytes);
    } catch (error) {
      this.invalid++;
      this.diagnostics.countFailure("store.span", error);
    }
  }

  private insert(
    span: unknown,
    identity: ReturnType<typeof readIdentity>,
    record: SpanRecord,
    bytes: number,
  ): void {
    let entry = this.traces.get(identity.traceId);
    if (entry === undefined) {
      const resource = readResource(span);
      entry = {
        traceId: identity.traceId,
        spans: [],
        spanIds: undefined,
        resource: resource.attributes,
        bytes: TRACE_BYTES + resource.bytes,
        root: undefined,
        candidates: [],
        hasJob: false,
        seq: 0,
        dead: false,
        errors: [],
      };
      this.traces.set(identity.traceId, entry);
      this.order.push(entry);
      this.bytes += entry.bytes;
    }
    if (hasSpan(entry, identity.spanId)) return;
    entry.spans.push(record);
    if (
      !entry.hasJob &&
      (record.kind === "consumer" ||
        record.attributes[ATTR_NESTRIX_ENTRY] === "job")
    ) {
      entry.hasJob = true;
    }
    if (entry.spanIds !== undefined) {
      entry.spanIds.add(identity.spanId);
    } else if (entry.spans.length > SMALL_TRACE_SPANS) {
      entry.spanIds = new Set(entry.spans.map((s) => s.spanId));
    }
    entry.bytes += bytes;
    this.bytes += bytes;
    this.spanCount++;
    if (identity.localRoot) entry.candidates.push(record);
    if (entry.candidates.length > 0) {
      entry.root = chooseRoot(entry);
      if (entry.seq === 0) {
        entry.seq = ++this.traceSeq;
        this.listed.push(entry);
      }
    }
    if (isErrorSpan(record)) {
      const item: ErrorEntry = {
        seq: ++this.errorSeq,
        trace: entry,
        span: record,
        dead: false,
      };
      entry.errors.push(item);
      this.errors.push(item);
      entry.bytes += ERROR_ITEM_BYTES;
      this.bytes += ERROR_ITEM_BYTES;
    }
    this.enforceLimits();
  }

  private enforceLimits(): void {
    const { maxTraces, maxBytes } = this.limits;
    while (
      this.traces.size > 0 &&
      (this.traces.size > maxTraces || this.bytes > maxBytes)
    ) {
      const oldest = this.order[this.orderHead] as TraceEntry;
      this.order[this.orderHead++] = undefined;
      this.evict(oldest);
    }
    if (this.orderHead > 1024 && this.orderHead * 2 > this.order.length) {
      this.order = this.order.slice(this.orderHead);
      this.orderHead = 0;
    }
    if (this.deadListed > 64 && this.deadListed * 2 > this.listed.length) {
      this.listed = this.listed.filter((e) => !e.dead);
      this.deadListed = 0;
    }
    if (this.deadErrors > 64 && this.deadErrors * 2 > this.errors.length) {
      this.errors = this.errors.filter((e) => !e.dead);
      this.deadErrors = 0;
    }
  }

  private evict(entry: TraceEntry): void {
    this.traces.delete(entry.traceId);
    entry.dead = true;
    this.bytes -= entry.bytes;
    this.spanCount -= entry.spans.length;
    this.evictedTraces++;
    if (entry.seq !== 0) {
      this.deadListed++;
    }
    for (const item of entry.errors) {
      item.dead = true;
      item.span = RELEASED;
      this.deadErrors++;
    }
    // Dead entries stay in `listed` and `errors` until the next compaction; release what
    // they hold now, so the byte limit bounds real memory and not only live records.
    entry.spans.length = 0;
    entry.spanIds = undefined;
    entry.errors.length = 0;
    entry.root = undefined;
    entry.candidates.length = 0;
    entry.resource = {};
  }

  private cursor(kind: CursorKind, seq: number): string {
    return encodeCursor(this.processId, kind, seq);
  }

  private summary(entry: TraceEntry): TraceSummary {
    const root = entry.root as SpanRecord;
    const item: TraceSummary = {
      traceId: entry.traceId,
      rootSpanId: root.spanId,
      name: root.name,
      error: isErrorSpan(root),
      startTimeUnixMs: root.startTimeUnixMs,
      durationMs: root.durationMs,
      spanCount: entry.spans.length,
      type: traceTypeOf(root),
      hasJob: entry.hasJob,
      cursor: this.cursor("t", entry.seq),
    };
    const method = stringAttr(root, ATTR_METHOD);
    if (method !== undefined) item.method = method;
    const route = stringAttr(root, ATTR_ROUTE);
    if (route !== undefined) item.route = route;
    const statusCode = statusCodeOf(root);
    if (statusCode !== undefined) item.statusCode = statusCode;
    const release = releaseOf(entry);
    if (release !== undefined) item.release = release;
    const user = stringAttr(root, ATTR_USER_ID);
    if (user !== undefined) item.user = user;
    return item;
  }

  listTraces(query: TraceListQuery): TraceListResponse {
    try {
      const method = query.method?.toUpperCase();
      const search = query.search?.toLowerCase();
      const matches = (entry: TraceEntry): boolean => {
        const root = entry.root as SpanRecord;
        const route = stringAttr(root, ATTR_ROUTE);
        if (query.route !== undefined && route !== query.route) return false;
        if (query.type === "job") {
          if (!entry.hasJob) return false;
        } else if (
          query.type !== undefined &&
          traceTypeOf(root) !== query.type
        ) {
          return false;
        }
        if (query.release !== undefined && releaseOf(entry) !== query.release) {
          return false;
        }
        if (
          query.user !== undefined &&
          stringAttr(root, ATTR_USER_ID) !== query.user
        ) {
          return false;
        }
        if (
          method !== undefined &&
          stringAttr(root, ATTR_METHOD)?.toUpperCase() !== method
        ) {
          return false;
        }
        if (
          query.minDurationMs !== undefined &&
          !(root.durationMs >= query.minDurationMs)
        ) {
          return false;
        }
        if (query.status !== undefined) {
          const code = statusCodeOf(root);
          const error = isErrorSpan(root);
          switch (query.status) {
            case "error":
              if (!error) return false;
              break;
            case "ok":
              if (error || (code !== undefined && code >= 400)) return false;
              break;
            case "4xx":
              if (code === undefined || code < 400 || code > 499) return false;
              break;
            case "5xx":
              if (code === undefined || code < 500 || code > 599) return false;
              break;
          }
        }
        if (search !== undefined && search !== "") {
          if (route?.toLowerCase().includes(search)) return true;
          for (const span of entry.spans) {
            if (span.name.toLowerCase().includes(search)) return true;
          }
          return false;
        }
        return true;
      };
      const result = page(
        this.listed,
        query,
        (c) => decodeCursor(c, this.processId, "t"),
        matches,
      );
      const items = result.items.map((e) => this.summary(e));
      const last = result.items[result.items.length - 1];
      return {
        items,
        head: result.head ? this.cursor("t", result.head.seq) : null,
        older: result.more && last ? this.cursor("t", last.seq) : null,
        reset: result.reset,
      };
    } catch (error) {
      this.diagnostics.countFailure("store.query", error);
      return { items: [], head: null, older: null, reset: true };
    }
  }

  scanTraces(
    sinceUnixMs: number,
    visit: (
      root: SpanRecord,
      spans: readonly SpanRecord[],
      resource: Attributes,
      traceId: string,
    ) => void,
  ): void {
    try {
      for (const entry of this.listed) {
        if (entry.dead || entry.root === undefined) continue;
        if (!(entry.root.startTimeUnixMs >= sinceUnixMs)) continue;
        visit(entry.root, entry.spans, entry.resource, entry.traceId);
      }
    } catch {
      // A failed query answers with what it had; it never reaches the caller.
    }
  }

  getTrace(traceId: string): TraceResponse | undefined {
    try {
      if (typeof traceId !== "string") return undefined;
      const entry = this.traces.get(traceId);
      if (entry === undefined) return undefined;
      const depths = depthsOf(entry.spans);
      // By start time; on a tie (spans started within the clock's resolution) a parent
      // before its descendants, whatever order they ended in.
      const spans = entry.spans
        .slice()
        .sort(
          (a, b) =>
            a.startTimeUnixMs - b.startTimeUnixMs ||
            (depths.get(a) ?? 0) - (depths.get(b) ?? 0),
        );
      let root = entry.root;
      if (root === undefined) {
        // Not listed yet (its local root has not ended): the earliest span whose parent
        // is not among the stored spans stands in.
        root = spans.find((s) => depths.get(s) === 0) ?? spans[0];
      }
      return {
        traceId: entry.traceId,
        rootSpanId: root?.spanId ?? "",
        resource: entry.resource,
        spans,
      };
    } catch (error) {
      this.diagnostics.countFailure("store.query", error);
      return undefined;
    }
  }

  private errorItem(entry: ErrorEntry): ErrorItem {
    const span = entry.span;
    const exception = span.events.find((e) => e.name === "exception");
    const endMs = span.startTimeUnixMs + span.durationMs;
    const item: ErrorItem = {
      traceId: entry.trace.traceId,
      spanId: span.spanId,
      spanName: span.name,
      spanKind: span.kind,
      timeUnixMs: exception?.timeUnixMs ?? endMs,
      cursor: this.cursor("e", entry.seq),
    };
    // The trace's root once it has ended; until then, the span itself.
    const source = entry.trace.root ?? span;
    const route = stringAttr(source, ATTR_ROUTE);
    if (route !== undefined) item.route = route;
    const method = stringAttr(source, ATTR_METHOD);
    if (method !== undefined) item.method = method;
    const statusCode = statusCodeOf(source);
    if (statusCode !== undefined) item.statusCode = statusCode;
    const type = exception?.attributes["exception.type"];
    const message = exception?.attributes["exception.message"];
    const errorType = typeof type === "string" ? type : span.status.message;
    if (errorType !== undefined) item.errorType = errorType;
    const text = typeof message === "string" ? message : span.status.message;
    if (text !== undefined) item.message = text;
    return item;
  }

  listErrors(query: ErrorListQuery): ErrorListResponse {
    try {
      const matches = (entry: ErrorEntry): boolean => {
        if (query.route === undefined) return true;
        const source = entry.trace.root ?? entry.span;
        return stringAttr(source, ATTR_ROUTE) === query.route;
      };
      const result = page(
        this.errors,
        query,
        (c) => decodeCursor(c, this.processId, "e"),
        matches,
      );
      const items = result.items.map((e) => this.errorItem(e));
      const last = result.items[result.items.length - 1];
      return {
        items,
        head: result.head ? this.cursor("e", result.head.seq) : null,
        older: result.more && last ? this.cursor("e", last.seq) : null,
        reset: result.reset,
      };
    } catch (error) {
      this.diagnostics.countFailure("store.query", error);
      return { items: [], head: null, older: null, reset: true };
    }
  }

  groupErrors(
    windowMinutes: number,
    now: number = Date.now(),
  ): ErrorGroupsResponse {
    try {
      const occurrences: ErrorOccurrence[] = [];
      for (const entry of this.errors) {
        if (entry.dead) continue;
        const item = this.errorItem(entry);
        const resourceService = entry.trace.resource["service.name"];
        const service =
          entry.span.service ??
          (typeof resourceService === "string" ? resourceService : undefined);
        occurrences.push({
          traceId: item.traceId,
          spanId: item.spanId,
          timeUnixMs: item.timeUnixMs,
          errorType: item.errorType,
          message: item.message,
          route: item.route,
          service,
        });
      }
      return groupErrors(occurrences, windowMinutes, now);
    } catch (error) {
      this.diagnostics.countFailure("store.query", error);
      return groupErrors([], windowMinutes, now);
    }
  }

  scanAllTraces(visit: (spans: readonly SpanRecord[]) => void): void {
    try {
      for (const entry of this.traces.values()) visit(entry.spans);
    } catch (error) {
      this.diagnostics.countFailure("store.query", error);
    }
  }

  stats(): StoreStats {
    const dropped =
      this.queueDropped +
      this.redactDropped +
      this.redactFailed +
      this.invalid +
      this.oversize;
    return {
      traces: this.traces.size,
      listedTraces: this.listed.length - this.deadListed,
      spans: this.spanCount,
      errorItems: this.errors.length - this.deadErrors,
      bytes: this.bytes,
      maxTraces: this.limits.maxTraces,
      maxBytes: this.limits.maxBytes,
      evictedTraces: this.evictedTraces,
      droppedSpans: dropped,
      queueDroppedSpans: this.queueDropped,
      redactDroppedSpans: this.redactDropped,
      redactFailedSpans: this.redactFailed,
      invalidSpans: this.invalid,
      oversizeSpans: this.oversize,
      receivedSpans: this.received,
      processors: this.processors,
      attached: this.attachments.length,
    };
  }

  /** Whether nothing was ever taken in, so limits can still change safely. */
  isPristine(): boolean {
    return this.received === 0 && this.traces.size === 0;
  }
}

let store: Store | undefined;

/**
 * The process's store, created on first call. `limits` given by the first caller that
 * passes them apply; a store created without them (by `nestrixSpanProcessor()`, which
 * takes no options) takes the defaults until a caller with limits arrives while it is
 * still empty. Later different limits are ignored with one log line. Never throws.
 */
export function getOrCreateStore(
  limits?: Partial<StoreLimits>,
  diagnostics: TelemetryDiagnostics = processDiagnostics,
): TraceStore {
  const wanted = limits === undefined ? undefined : normaliseLimits(limits);
  if (store === undefined) {
    store = new Store(
      wanted ?? DEFAULT_STORE_LIMITS,
      wanted !== undefined,
      diagnostics,
    );
    return store;
  }
  if (wanted !== undefined) {
    const current = store.limits;
    const same =
      current.maxTraces === wanted.maxTraces &&
      current.maxBytes === wanted.maxBytes;
    if (!store.limitsExplicit && store.isPristine()) {
      store.limits = wanted;
      store.limitsExplicit = true;
    } else if (!same) {
      diagnostics.logOnce(
        "store.limits-ignored",
        `The dashboard store already exists in this process with maxTraces ${current.maxTraces} and maxBytes ${current.maxBytes}; the store option of a later Nestrix app is ignored.`,
      );
    }
  }
  return store;
}

/** The process's store if one was created. */
export function getStore(): TraceStore | undefined {
  return store;
}

/** For tests only: forget the store. */
export function resetStoreForTests(): void {
  store = undefined;
}
