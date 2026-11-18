/**
 * Local tail decision (issue #43, D-100): the state shared by the provider's sampler and span
 * processor (`otel/tail-sampling.ts`, setup code) and by Nestrix's own instrumentation, which must
 * not skip spans of a trace that is still being recorded for the decision.
 *
 * Only when Nestrix owns the tracer provider and `sampleRate` is below 1 (D-69: a host SDK owns
 * sampling). A new root trace that the ratio does not sample is recorded anyway (`RECORD`, trace
 * flags `00`, so every `traceparent` sent downstream still carries the head decision); its spans
 * are held until its local root ends, then exported when the trace failed or the root was slower
 * than `sampling.keepSlowerThanMs`, and dropped otherwise.
 *
 * Imports nothing from the SDK (rule 5); the class is generic over the span type. Every exported
 * function catches everything (rule 1). Bounded: at most {@link MAX_BUFFERED_SPANS} spans held and
 * {@link MAX_TAIL_TRACES} traces tracked in each map; the oldest trace goes first, and the spans it
 * held are counted as dropped.
 */
import { diagnostics } from "./diagnostics.js";
import type { TraceLogInput } from "./logs/sink.js";

/** The keep probability of a local root, written on it as it ends (issue #30). */
export const ATTR_SAMPLING_PROBABILITY = "nestrix.sampling.probability";
/** Spans held for undecided traces, in the whole process. */
export const MAX_BUFFERED_SPANS = 10_000;
/** Traces tracked per map (undecided, decided, sampled traces with a failure). */
export const MAX_TAIL_TRACES = 10_000;
/** Log lines held for one undecided trace; more are dropped and counted. */
export const MAX_HELD_LOGS_PER_TRACE = 50;

interface Pending<S> {
  /** Recorded local roots started and not yet ended. */
  liveRoots: number;
  /** Ended spans waiting for the decision. */
  spans: S[];
  /** Log lines written under the trace's recording spans, waiting for the decision. */
  logs: TraceLogInput[];
  /** A span of the trace failed (D-94: status error, unless every exception on it is expected). */
  failed: boolean;
  /** A root that ended said keep: from then on spans are passed on at once. */
  keep: boolean;
  /** The decision a root's `onEnding` took, read by its `onEnd`; cleared there. */
  rootDecision: boolean | undefined;
}

/**
 * Per-trace state of the tail decision. Not thread-safe and not meant to be: every caller runs on
 * Node's one thread and each method finishes synchronously.
 */
export class TailRegistry<S> {
  private readonly pending = new Map<string, Pending<S>>();
  /** Decided traces: `true` kept, `false` dropped. Late spans follow the decision. */
  private readonly decided = new Map<string, boolean>();
  /** Sampled (head) traces in which a span failed before the root ended. */
  private readonly sampledFailed = new Set<string>();
  private bufferedSpans = 0;
  /** Spans dropped because a bound was reached (not the spans the decision dropped). */
  droppedSpans = 0;
  /** Log lines dropped because a bound was reached (not the lines the decision dropped). */
  droppedLogs = 0;
  private readonly maxSpans: number;
  private readonly maxTraces: number;
  private readonly onDropped: (count: number) => void;

  constructor(
    options: {
      maxSpans?: number;
      maxTraces?: number;
      onDropped?: (count: number) => void;
    } = {},
  ) {
    this.maxSpans = options.maxSpans ?? MAX_BUFFERED_SPANS;
    this.maxTraces = options.maxTraces ?? MAX_TAIL_TRACES;
    this.onDropped = options.onDropped ?? (() => {});
  }

  /** Spans held now, for tests and diagnostics. */
  get buffered(): number {
    return this.bufferedSpans;
  }

  /** Undecided traces now, for tests and diagnostics. */
  get pendingTraces(): number {
    return this.pending.size;
  }

  /** Whether spans of `traceId` are recorded although its trace flags are `00`. */
  isRecording(traceId: string): boolean {
    return this.pending.has(traceId) || this.decided.get(traceId) === true;
  }

  /** An unsampled new root of `traceId` started (the processor's `onStart`). */
  rootStarted(traceId: string): void {
    const found = this.pending.get(traceId);
    if (found !== undefined) {
      found.liveRoots++;
      return;
    }
    if (this.pending.size >= this.maxTraces) this.evictOldest();
    this.pending.set(traceId, {
      liveRoots: 1,
      spans: [],
      logs: [],
      failed: false,
      keep: false,
      rootDecision: undefined,
    });
  }

  /** Whether a span of the trace failed so far (for the root's decision). */
  hasFailed(traceId: string): boolean {
    return this.pending.get(traceId)?.failed === true;
  }

  /** The root's `onEnding` decided; its `onEnd` reads it back with {@link takeRootDecision}. */
  setRootDecision(traceId: string, keep: boolean): void {
    const entry = this.pending.get(traceId);
    if (entry !== undefined) entry.rootDecision = keep;
  }

  /** The decision `onEnding` took for the root now in `onEnd`; `undefined` when it took none. */
  takeRootDecision(traceId: string): boolean | undefined {
    const entry = this.pending.get(traceId);
    if (entry === undefined) return undefined;
    const decision = entry.rootDecision;
    entry.rootDecision = undefined;
    return decision;
  }

  /**
   * A non-root span of an unsampled trace ended. Returns what to do with it: `pass` it on now
   * (kept trace), `drop` it (dropped, evicted or unknown trace), or `held` (buffered).
   */
  childEnded(
    traceId: string,
    span: S,
    failed: boolean,
  ): "pass" | "drop" | "held" {
    const entry = this.pending.get(traceId);
    if (entry === undefined) {
      return this.decided.get(traceId) === true ? "pass" : "drop";
    }
    if (failed) entry.failed = true;
    if (entry.keep) return "pass";
    if (!this.makeRoom(traceId, entry)) {
      this.countDropped(1);
      return "drop";
    }
    entry.spans.push(span);
    this.bufferedSpans++;
    return "held";
  }

  /**
   * A log line was written under a recording span of an unsampled trace. `held`: kept until the
   * decision ({@link rootEnded} hands it back when the trace is kept); `pass`: the trace is kept,
   * give it to the store now; `drop`: the trace was dropped or evicted, or a bound was reached;
   * `unknown`: the registry does not track the trace.
   */
  holdLog(
    traceId: string,
    log: TraceLogInput,
  ): "held" | "pass" | "drop" | "unknown" {
    const entry = this.pending.get(traceId);
    if (entry === undefined) {
      const decision = this.decided.get(traceId);
      if (decision === undefined) return "unknown";
      return decision ? "pass" : "drop";
    }
    if (entry.keep) return "pass";
    if (
      entry.logs.length >= MAX_HELD_LOGS_PER_TRACE ||
      !this.makeRoom(traceId, entry)
    ) {
      this.countDroppedLogs(1);
      return "drop";
    }
    entry.logs.push(log);
    this.bufferedSpans++;
    return "held";
  }

  /**
   * Makes room for one more held item (span or log line) of `entry`: evicts the oldest undecided
   * traces that hold something until the total is under the bound. False when `entry` itself was
   * evicted on the way.
   */
  private makeRoom(traceId: string, entry: Pending<S>): boolean {
    while (this.bufferedSpans >= this.maxSpans) {
      if (!this.evictOldest(true)) break;
    }
    return this.pending.get(traceId) === entry;
  }

  /**
   * A local root of an unsampled trace ended with decision `keep`. Returns the held spans and log
   * lines to pass on (kept) or nothing (dropped). When its last live root ended, the trace is
   * decided. `undefined` when the trace is not tracked (evicted): the root is then dropped too.
   */
  rootEnded(
    traceId: string,
    keep: boolean,
  ): { spans: S[]; logs: TraceLogInput[] } | undefined {
    const entry = this.pending.get(traceId);
    if (entry === undefined) return undefined;
    if (entry.liveRoots > 0) entry.liveRoots--;
    const released: { spans: S[]; logs: TraceLogInput[] } = {
      spans: [],
      logs: [],
    };
    if (keep && !entry.keep) {
      entry.keep = true;
      released.spans = entry.spans;
      released.logs = entry.logs;
      this.bufferedSpans -= entry.spans.length + entry.logs.length;
      entry.spans = [];
      entry.logs = [];
    }
    if (entry.liveRoots === 0) {
      this.pending.delete(traceId);
      this.bufferedSpans -= entry.spans.length + entry.logs.length;
      entry.spans = [];
      entry.logs = [];
      this.decide(traceId, entry.keep);
    }
    return released;
  }

  /** A span of a sampled (head) trace failed before its root ended. */
  noteSampledFailure(traceId: string): void {
    if (this.sampledFailed.has(traceId)) return;
    if (this.sampledFailed.size >= this.maxTraces) {
      const oldest = this.sampledFailed.values().next();
      if (!oldest.done) this.sampledFailed.delete(oldest.value);
    }
    this.sampledFailed.add(traceId);
  }

  /** The sampled trace's root is ending: whether a span failed before it; forgets the trace. */
  takeSampledFailure(traceId: string): boolean {
    return this.sampledFailed.delete(traceId);
  }

  /** Forgets everything (provider shutdown). Held spans are not counted as dropped. */
  clear(): void {
    this.pending.clear();
    this.decided.clear();
    this.sampledFailed.clear();
    this.bufferedSpans = 0;
  }

  private decide(traceId: string, keep: boolean): void {
    if (this.decided.size >= this.maxTraces) {
      const oldest = this.decided.keys().next();
      if (!oldest.done) this.decided.delete(oldest.value);
    }
    this.decided.set(traceId, keep);
  }

  /**
   * Forgets the oldest undecided trace (with `holding`: the oldest one that holds a span or a log
   * line, so evicting frees something); the spans it held are counted as dropped. False when
   * there was nothing to evict.
   */
  private evictOldest(holding = false): boolean {
    let found: [string, Pending<S>] | undefined;
    for (const item of this.pending) {
      if (!holding || item[1].spans.length + item[1].logs.length > 0) {
        found = item;
        break;
      }
    }
    if (found === undefined) return false;
    const [traceId, entry] = found;
    this.pending.delete(traceId);
    this.bufferedSpans -= entry.spans.length + entry.logs.length;
    // Its later spans are not recorded (the sampler asks `isRecording`), and any that end are dropped.
    this.decide(traceId, false);
    this.countDropped(entry.spans.length);
    if (entry.logs.length > 0) this.countDroppedLogs(entry.logs.length);
    diagnostics.logOnce(
      "tail-sampling.evicted",
      `The tail-sampling buffer reached its bound (${this.maxSpans} spans or ${this.maxTraces} undecided traces), so the oldest undecided trace was dropped; such drops are counted in getExportStatus().traces.dropped. Lower the load, or raise sampleRate.`,
    );
    return true;
  }

  /** Counts `count` log lines dropped at a bound. */
  private countDroppedLogs(count: number): void {
    this.droppedLogs += count;
  }

  /** Counts `count` spans dropped at a bound. */
  countDropped(count: number): void {
    if (count <= 0) return;
    this.droppedSpans += count;
    try {
      this.onDropped(count);
    } catch {
      // Counting never throws into the processor.
    }
  }
}

// ---- the installed registry --------------------------------------------------------------------

let installed: TailRegistry<unknown> | undefined;

/** Makes `registry` the process's registry; returns the uninstaller (idempotent). */
export function installTailRegistry(
  registry: TailRegistry<unknown>,
): () => void {
  installed = registry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (installed === registry) {
      installed = undefined;
      registry.clear();
    }
  };
}

/**
 * Whether a span under an unsampled parent of `traceId` is still recorded for the tail decision.
 * Nestrix's instrumentation asks this before skipping a span under an unsampled parent. Never throws.
 */
export function isTailRecording(traceId: string): boolean {
  try {
    return installed?.isRecording(traceId) === true;
  } catch (error) {
    diagnostics.countFailure("tail-sampling.recording", error);
    return false;
  }
}

/**
 * What to do with a log line written under a recording span whose trace flags are `00` (D-100):
 * `held` (the registry keeps it until the trace is decided), `pass` (the trace is kept: give it to
 * the store now), `drop` (dropped trace, or a bound), `unknown` (the registry does not track the
 * trace: the caller decides as before). Never throws.
 */
export function holdTraceLog(
  log: TraceLogInput,
): "held" | "pass" | "drop" | "unknown" {
  try {
    return installed?.holdLog(log.traceId, log) ?? "unknown";
  } catch (error) {
    diagnostics.countFailure("tail-sampling.log", error);
    return "drop";
  }
}
