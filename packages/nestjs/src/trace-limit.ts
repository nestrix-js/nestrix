/**
 * `maxSpansPerTrace` (D-78, P13-01): at most `limit` spans of one trace are recorded in this
 * process; the rest are counted by kind and the counts are written on the trace's local root span
 * as `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>`.
 *
 * Imports `@opentelemetry/api` only (rule 5). Two ways in, never both at once:
 *
 * - **Nestrix owns the provider.** `otel/span-limit.ts` wraps the provider's sampler (every span,
 *   whoever creates it, asks {@link TraceSpanCounter.tryRecord}) and adds a span processor whose
 *   `onEnding` writes the counts on each local root (a span with no parent or a remote parent).
 * - **The host owns the SDK.** Only Nestrix's own spans are limited: each Nestrix call site starts
 *   its span through {@link startNestrixSpan} (or {@link hostGate} and {@link hostStarted}) and
 *   ends it through {@link endNestrixSpan}. The "root" is the first Nestrix span of the trace in
 *   this process; the counts are written on it just before it ends.
 *
 * Every exported function catches everything (rule 1). Per-trace state lives in one bounded map.
 */
import {
  type Attributes,
  type Context,
  INVALID_SPANID,
  INVALID_TRACEID,
  type Span,
  type SpanContext,
  SpanKind,
  type SpanOptions,
  type TimeInput,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { diagnostics } from "./diagnostics.js";
import { type SpanFacts, timeKeyOf } from "./overview/compute.js";

/** Default `maxSpansPerTrace`. */
export const DEFAULT_MAX_SPANS_PER_TRACE = 10_000;
/** Smallest accepted `maxSpansPerTrace`. */
export const MIN_MAX_SPANS_PER_TRACE = 100;
/** Live traces tracked at most; the oldest is forgotten past this. */
export const MAX_TRACKED_TRACES = 10_000;
/** A trace untouched for this long is forgotten. */
export const TRACE_IDLE_MILLIS = 60 * 60 * 1000;

export const ATTR_SPANS_DROPPED = "nestrix.trace.spans_dropped";
export const ATTR_SPANS_DROPPED_PREFIX = "nestrix.trace.spans_dropped.";

interface Entry {
  /** Spans recorded so far (the limit applies to this). */
  recorded: number;
  /** Dropped since the counts were last written on a root. */
  dropped: number;
  /** Same, by kind; created on the first drop. */
  byKind: Record<string, number> | undefined;
  /** Local roots started and not yet ended (provider mode). */
  liveRoots: number;
  /** The span the counts go on (host mode); cleared when it ends under `keep`. */
  root: Span | undefined;
  /** Host mode: the root had a local sampled parent, so the entry outlives it (see `hostEnding`). */
  keep: boolean;
  /** Clock at creation, then refreshed every 64th touch (see `touch`). */
  lastSeen: number;
  touches: number;
}

export interface TraceSpanCounterOptions {
  maxTraces?: number;
  idleMillis?: number;
  now?: () => number;
}

const KIND_NAMES: Readonly<Record<number, string>> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer",
};

function str(a: Attributes | undefined, key: string): string | undefined {
  const v = a?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The dashboard's time-by-kind key (`OverviewTimeShare.key`) of a span, from what is known at its start. */
export function dropKindOf(
  kind: SpanKind | undefined,
  attributes: Attributes | undefined,
): string {
  try {
    const facts: SpanFacts = {
      kind: KIND_NAMES[kind ?? SpanKind.INTERNAL] ?? "internal",
      dbSystem: (
        str(attributes, "db.system.name") ?? str(attributes, "db.system")
      )?.toLowerCase(),
      messaging: str(attributes, "messaging.system") !== undefined,
      http:
        str(attributes, "http.request.method") !== undefined ||
        str(attributes, "http.method") !== undefined ||
        str(attributes, "url.full") !== undefined,
      nest:
        str(attributes, "nestrix.class") !== undefined ||
        str(attributes, "nestrix.component") !== undefined,
    };
    return timeKeyOf(facts);
  } catch {
    return "other";
  }
}

/**
 * Per-trace span counts. Not thread-safe and not meant to be: Node runs every caller on one
 * thread, and each method finishes synchronously.
 */
export class TraceSpanCounter {
  readonly limit: number;
  private readonly traces = new Map<string, Entry>();
  private readonly maxTraces: number;
  private readonly idleMillis: number;
  private readonly now: () => number;
  /** Traces forgotten while still live (map full); for diagnostics and tests. */
  evicted = 0;

  constructor(limit: number, options: TraceSpanCounterOptions = {}) {
    this.limit = limit;
    this.maxTraces = options.maxTraces ?? MAX_TRACKED_TRACES;
    this.idleMillis = options.idleMillis ?? TRACE_IDLE_MILLIS;
    this.now = options.now ?? Date.now;
  }

  /** Traces tracked now. */
  get size(): number {
    return this.traces.size;
  }

  /** Forgets everything (provider shutdown). */
  clear(): void {
    this.traces.clear();
  }

  private create(traceId: string, now: number): Entry {
    this.sweep(now);
    const entry: Entry = {
      recorded: 0,
      dropped: 0,
      byKind: undefined,
      liveRoots: 0,
      root: undefined,
      keep: false,
      lastSeen: now,
      touches: 0,
    };
    this.traces.set(traceId, entry);
    return entry;
  }

  /**
   * Before inserting: look at up to 8 entries at the head of the map. An idle one is forgotten; any
   * other moves to the tail, so idle ones behind it are reached on later insertions. When the map
   * is full, the first scanned entry that is not live (no local root still running, no host root
   * still open: a leftover whose root never ends) is forgotten instead; a live one is forgotten
   * only when all 8 scanned are live. Constant work per new trace.
   */
  private sweep(now: number): void {
    let firstMoved: string | undefined;
    for (let i = 0; i < 8; i++) {
      const head = this.traces.entries().next();
      if (head.done) return;
      const [id, entry] = head.value;
      if (now - entry.lastSeen > this.idleMillis) {
        this.traces.delete(id);
        continue;
      }
      if (
        this.traces.size >= this.maxTraces &&
        entry.liveRoots === 0 &&
        entry.root === undefined
      ) {
        this.traces.delete(id);
        return;
      }
      this.traces.delete(id);
      this.traces.set(id, entry);
      firstMoved ??= id;
    }
    if (this.traces.size < this.maxTraces || firstMoved === undefined) return;
    this.traces.delete(firstMoved);
    this.evicted++;
    diagnostics.logOnce(
      "trace-limit.evicted",
      `More than ${this.maxTraces} traces were live at once; maxSpansPerTrace forgot the oldest one, so its limit starts again and its dropped-span counts may be incomplete.`,
    );
  }

  /**
   * A span the sampler would record. `true`: record it (counted). `false`: the trace has reached
   * the limit; the span is counted as dropped under `kind`/`attributes`.
   */
  tryRecord(
    traceId: string,
    kind: SpanKind | undefined,
    attributes: Attributes | undefined,
  ): boolean {
    const found = this.traces.get(traceId);
    let entry: Entry;
    if (found === undefined) entry = this.create(traceId, this.now());
    else {
      entry = found;
      this.touch(entry);
    }
    if (entry.recorded >= this.limit) {
      this.addDrop(entry, kind, attributes);
      return false;
    }
    entry.recorded++;
    return true;
  }

  /** A recorded local root of `traceId` started (the processor's `onStart`; after `tryRecord`). */
  rootStarted(traceId: string): void {
    const entry = this.traces.get(traceId);
    if (entry !== undefined) entry.liveRoots++;
  }

  /**
   * A span that is not recorded because its parent was not. Counted only for a tracked trace that
   * has reached the limit, so its unrecorded parent was one this counter dropped; an unsampled
   * trace is never tracked.
   */
  dropDescendant(
    traceId: string,
    kind: SpanKind | undefined,
    attributes: Attributes | undefined,
  ): void {
    const entry = this.traces.get(traceId);
    if (entry === undefined || entry.recorded < this.limit) return;
    this.touch(entry);
    this.addDrop(entry, kind, attributes);
  }

  /**
   * Marks `entry` as used. The clock is read on every 64th use only: `Date.now()` costs about as
   * much as everything else here put together (about 47 ns on darwin-arm64, Node 26), and an idle
   * limit of an hour does not need more precision. A trace touched fewer than 64 times in an hour
   * may be forgotten while live; then its limit starts again, which matters only for a trace that
   * small and slow.
   */
  private touch(entry: Entry): void {
    if ((++entry.touches & 63) === 0) entry.lastSeen = this.now();
  }

  private addDrop(
    entry: Entry,
    kind: SpanKind | undefined,
    attributes: Attributes | undefined,
  ): void {
    entry.dropped++;
    const key = dropKindOf(kind, attributes);
    entry.byKind ??= {};
    entry.byKind[key] = (entry.byKind[key] ?? 0) + 1;
  }

  /**
   * A local root of `traceId` is ending: writes the counts dropped since the last write on `span`
   * (each local root carries its own share; the server sums them over the trace) and forgets the
   * trace when its last live root ended.
   */
  rootEnding(traceId: string, span: Pick<Span, "setAttribute">): void {
    const entry = this.traces.get(traceId);
    if (entry === undefined) return;
    if (entry.liveRoots > 0) entry.liveRoots--;
    try {
      writeCounts(entry, span);
    } finally {
      if (entry.liveRoots === 0) this.traces.delete(traceId);
    }
  }

  // ---- host mode -----------------------------------------------------------------------------

  /** Host mode: whether a child of a sampled parent in `traceId` may be recorded (counted either way). */
  hostAdmit(
    traceId: string,
    kind: SpanKind | undefined,
    attributes: Attributes | undefined,
  ): boolean {
    const entry = this.traces.get(traceId);
    if (entry === undefined) return true; // hostStarted creates it
    this.touch(entry);
    if (entry.recorded >= this.limit) {
      this.addDrop(entry, kind, attributes);
      return false;
    }
    entry.recorded++;
    return true;
  }

  /**
   * Host mode: a sampled Nestrix span started. The first one of a trace becomes its root; so does
   * the first one admitted after a kept root ended. `keep`: its parent is a local sampled span
   * (the host's own), so the trace goes on after it ends and its siblings share one budget.
   */
  hostStarted(traceId: string, span: Span, keep = false): void {
    const found = this.traces.get(traceId);
    if (found !== undefined) {
      if (found.root === undefined) {
        found.root = span;
        found.keep = keep;
      }
      return;
    }
    const entry = this.create(traceId, this.now());
    entry.recorded = 1;
    entry.root = span;
    entry.keep = keep;
  }

  /**
   * Host mode: `span` is ending; when it is its trace's root, the counts go on it. The trace is
   * then forgotten, unless the root had a local sampled parent: its entry stays (no root, same
   * counts) for the next Nestrix span to carry later counts, until idle expiry or eviction.
   */
  hostEnding(traceId: string, span: Span): void {
    const entry = this.traces.get(traceId);
    if (entry === undefined || entry.root !== span) return;
    if (entry.keep) entry.root = undefined;
    else this.traces.delete(traceId);
    writeCounts(entry, span);
  }
}

function writeCounts(entry: Entry, span: Pick<Span, "setAttribute">): void {
  if (entry.dropped === 0) return;
  const dropped = entry.dropped;
  const byKind = entry.byKind;
  entry.dropped = 0;
  entry.byKind = undefined;
  span.setAttribute(ATTR_SPANS_DROPPED, dropped);
  if (byKind !== undefined) {
    for (const key of Object.keys(byKind)) {
      span.setAttribute(
        `${ATTR_SPANS_DROPPED_PREFIX}${key}`,
        byKind[key] as number,
      );
    }
  }
}

// ---- the installed counter -------------------------------------------------------------------

type Mode = "provider" | "host";

let installed:
  | { counter: TraceSpanCounter; mode: Mode; refs: number }
  | undefined;

/**
 * Makes `counter` the process's counter and returns the uninstaller (idempotent). While one is
 * installed, a further install shares it (the first app's limit wins, like `sampleRate`) and adds
 * a reference; the counter goes when the last reference is released.
 */
export function installTraceSpanCounter(
  counter: TraceSpanCounter,
  mode: Mode,
): () => void {
  const mine = installed ?? { counter, mode, refs: 0 };
  installed = mine;
  mine.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.refs--;
    if (mine.refs === 0 && installed === mine) {
      installed = undefined;
      mine.counter.clear();
    }
  };
}

/** The installed counter and its mode, for tests and diagnostics. */
export function installedTraceSpanCounter():
  | { counter: TraceSpanCounter; mode: Mode }
  | undefined {
  return installed;
}

/**
 * A span context with real ids, checked against the all-zero ids only (what
 * `INVALID_SPAN_CONTEXT` carries), as `methods/wrap.ts` does: `isSpanContextValid` runs two
 * regular expressions, too slow for every span.
 */
function hasIds(sc: SpanContext | undefined): sc is SpanContext {
  return (
    sc !== undefined &&
    sc.traceId !== INVALID_TRACEID &&
    sc.spanId !== INVALID_SPANID
  );
}

function isSampled(sc: SpanContext | undefined): sc is SpanContext {
  return hasIds(sc) && (sc.traceFlags & TraceFlags.SAMPLED) !== 0;
}

/**
 * A Nestrix span is being skipped because its parent is not sampled (methods/wrap.ts). When that
 * parent was dropped by the limit, the skipped span counts as dropped too. Never throws.
 */
export function noteSkippedSpan(
  ctx: Context,
  kind: SpanKind,
  attributes: Attributes | undefined,
): void {
  try {
    if (installed === undefined) return;
    const sc = trace.getSpanContext(ctx);
    if (!hasIds(sc)) return;
    installed.counter.dropDescendant(sc.traceId, kind, attributes);
  } catch (error) {
    diagnostics.countFailure("trace-limit.skipped", error);
  }
}

/**
 * Host mode, before a Nestrix span starts under `ctx`: a non-recording stand-in when the trace has
 * reached the limit (it carries the parent's span context, so children and `traceparent` keep
 * pointing at a recorded span, sampled), else `undefined`. Never throws.
 */
export function hostGate(
  ctx: Context,
  kind: SpanKind | undefined,
  attributes: Attributes | undefined,
  root?: boolean,
): Span | undefined {
  try {
    if (installed === undefined || installed.mode !== "host" || root) {
      return undefined;
    }
    const parent = trace.getSpanContext(ctx);
    if (!isSampled(parent)) return undefined;
    if (installed.counter.hostAdmit(parent.traceId, kind, attributes)) {
      return undefined;
    }
    return trace.wrapSpanContext(parent);
  } catch (error) {
    diagnostics.countFailure("trace-limit.gate", error);
    return undefined;
  }
}

/**
 * Host mode, after a Nestrix span that passed {@link hostGate} started under `parentCtx`. Never
 * throws.
 */
export function hostStarted(span: Span, parentCtx?: Context): void {
  try {
    if (installed === undefined || installed.mode !== "host") return;
    const sc = span.spanContext();
    if (!isSampled(sc)) return;
    const parent =
      parentCtx === undefined ? undefined : trace.getSpanContext(parentCtx);
    installed.counter.hostStarted(
      sc.traceId,
      span,
      isSampled(parent) && parent.isRemote !== true,
    );
  } catch (error) {
    diagnostics.countFailure("trace-limit.started", error);
  }
}

/**
 * Starts a Nestrix span with `tracer`, applying the limit in host mode. The tracer's own throw
 * propagates as it did before (call sites already guard it); the limit's never does.
 */
export function startNestrixSpan(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  ctx: Context,
): Span {
  const standIn = hostGate(ctx, options.kind, options.attributes, options.root);
  if (standIn !== undefined) return standIn;
  const span = tracer.startSpan(name, options, ctx);
  hostStarted(span, ctx);
  return span;
}

/**
 * Ends a Nestrix span; in host mode, first writes the dropped counts on it when it is its trace's
 * root. `span.end()` throws as it did before; the limit's part never does.
 */
export function endNestrixSpan(span: Span, endTime?: TimeInput): void {
  if (installed !== undefined && installed.mode === "host") {
    try {
      installed.counter.hostEnding(span.spanContext().traceId, span);
    } catch (error) {
      diagnostics.countFailure("trace-limit.ending", error);
    }
  }
  span.end(endTime);
}
