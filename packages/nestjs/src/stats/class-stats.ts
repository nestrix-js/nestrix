/**
 * Pre-sampling per-class and per-method statistics (phase 3, backlog P3-04, D-56).
 *
 * The level 2 method wrappers report every completed call to the installed `MethodCallSink`
 * (`src/methods/sink.ts`), sampled or not. This class is that sink while the dashboard is on; the
 * classes endpoint calls `query()`.
 *
 * Layout, per (class, method): a ring of 60 one-minute slots (the same wall-clock bucketing as
 * `route-stats.ts`), each tagged with the minute it holds so a stale slot is cleared on reuse,
 * holding the call count, error count, summed duration and largest duration. All arrays are typed
 * arrays allocated once, when the method is first seen. `record()` allocates nothing once the
 * method exists: lookups go through two nested maps (class, then method).
 *
 * Bounds: at most `MAX_CLASSES` classes and `MAX_METHODS_PER_CLASS` methods per class. A further
 * class is counted under the class `(other)` (method `(other)`); a further method of a known
 * class is counted under that class's method `(other)`.
 *
 * Nothing here imports OpenTelemetry or Nest. `record()` and `query()` never throw on any input
 * (a non-finite or negative duration counts as 0 ms; a non-finite time is ignored).
 *
 * The result shapes are mirrored in `store/protocol-types.ts` (checked against `@nestrix/protocol`).
 */
import type { MethodCallSink, MethodClassKind } from "../methods/sink.js";
import type {
  ClassKind,
  ClassStats,
  ClassStatsResponse,
  MethodStats,
  SpanRecord,
} from "../store/protocol-types.js";
import { BUCKET_MS, statsNow, WINDOW_BUCKETS } from "./route-stats.js";

export const MAX_CLASSES = 500;
export const MAX_METHODS_PER_CLASS = 50;
/** Name of the overflow class and of the overflow method. */
export const OTHER = "(other)";

/** Span attributes the method wrappers set (backlog P3, "Method span shape"). */
export const ATTR_CLASS = "nestrix.class";
export const ATTR_METHOD = "nestrix.method";

class MethodSeries {
  readonly minute = new Int32Array(WINDOW_BUCKETS).fill(-1);
  readonly calls = new Uint32Array(WINDOW_BUCKETS);
  readonly errors = new Uint32Array(WINDOW_BUCKETS);
  readonly total = new Float64Array(WINDOW_BUCKETS);
  readonly max = new Float64Array(WINDOW_BUCKETS);
  constructor(readonly method: string) {}
}

class ClassEntry {
  readonly methods = new Map<string, MethodSeries>();
  other: MethodSeries | undefined;
  constructor(
    readonly className: string,
    readonly kind: MethodClassKind,
  ) {}
}

/**
 * Whether method spans are on. TODO(P3-02 merge): replace with `methodsEnabled()` from
 * `src/methods/`; until then, whether any call has been recorded.
 */
export function methodsEnabledStub(stats: ClassStatistics): boolean {
  return stats.hasRecorded;
}

/** Own time per (class, method), as a sampled average; see `ownAverages`. */
export type OwnAverages = ReadonlyMap<string, ReadonlyMap<string, number>>;

export class ClassStatistics implements MethodCallSink {
  readonly sinceUnixMs: number;
  private readonly classes = new Map<string, ClassEntry>();
  private other: ClassEntry | undefined;
  private recorded = false;

  constructor(nowUnixMs: number = statsNow()) {
    this.sinceUnixMs = nowUnixMs;
  }

  /** Whether any call has been recorded. */
  get hasRecorded(): boolean {
    return this.recorded;
  }

  /** Distinct classes tracked, not counting `(other)`. */
  get classCount(): number {
    return this.classes.size;
  }

  /** `MethodCallSink.record`, stamped with the current wall time. Never throws. */
  record(
    className: string,
    kind: MethodClassKind,
    method: string,
    durationMs: number,
    error: boolean,
  ): void {
    this.recordAt(className, kind, method, durationMs, error, statsNow());
  }

  /** `record` with an explicit wall time (Unix ms). Allocation-free once the method exists. Never throws. */
  recordAt(
    className: string,
    kind: MethodClassKind,
    method: string,
    durationMs: number,
    error: boolean,
    nowUnixMs: number,
  ): void {
    try {
      if (!Number.isFinite(nowUnixMs)) return;
      const s = this.seriesFor(className, kind, method);
      this.recorded = true;
      const minute = Math.floor(nowUnixMs / BUCKET_MS);
      const slot = minute % WINDOW_BUCKETS;
      if (s.minute[slot] !== minute) {
        s.minute[slot] = minute;
        s.calls[slot] = 0;
        s.errors[slot] = 0;
        s.total[slot] = 0;
        s.max[slot] = 0;
      }
      const ms =
        durationMs >= 0 && Number.isFinite(durationMs) ? durationMs : 0;
      (s.calls[slot] as number)++;
      if (error) (s.errors[slot] as number)++;
      (s.total[slot] as number) += ms;
      if (ms > (s.max[slot] as number)) s.max[slot] = ms;
    } catch {
      // Rule 1: a statistics fault never reaches the host's method call.
    }
  }

  /**
   * Window sums for the last `windowMinutes` minutes (clamped to 1..60), the current minute
   * included. `own` supplies `ownAvgMs` per (class, method) from the store's sampled spans; a
   * method without an entry gets `null`. Classes are ordered by `totalMs`, highest first.
   * `methodsEnabled` is the caller's. Never throws.
   */
  query(
    windowMinutes: number,
    methodsEnabled: boolean,
    own?: OwnAverages,
    nowUnixMs: number = statsNow(),
  ): ClassStatsResponse {
    const window = Math.min(
      WINDOW_BUCKETS,
      Math.max(1, Math.floor(Number(windowMinutes) || 0)),
    );
    const now = Number.isFinite(nowUnixMs) ? nowUnixMs : statsNow();
    const last = Math.floor(now / BUCKET_MS);
    const first = last - window + 1;
    const out: ClassStats[] = [];
    try {
      const entries: ClassEntry[] = [...this.classes.values()];
      if (this.other) entries.push(this.other);
      for (const entry of entries) {
        const series: MethodSeries[] = [...entry.methods.values()];
        if (entry.other) series.push(entry.other);
        const methods: MethodStats[] = [];
        let calls = 0;
        let errors = 0;
        let totalMs = 0;
        let ownMs: number | null = null;
        for (const s of series) {
          let c = 0;
          let e = 0;
          let t = 0;
          let m = 0;
          for (let minute = first; minute <= last; minute++) {
            const slot =
              ((minute % WINDOW_BUCKETS) + WINDOW_BUCKETS) % WINDOW_BUCKETS;
            if (s.minute[slot] !== minute) continue;
            c += s.calls[slot] as number;
            e += s.errors[slot] as number;
            t += s.total[slot] as number;
            if ((s.max[slot] as number) > m) m = s.max[slot] as number;
          }
          if (c === 0) continue;
          const ownAvg = own?.get(entry.className)?.get(s.method) ?? null;
          methods.push({
            method: s.method,
            calls: c,
            errors: e,
            totalMs: round(t),
            avgMs: round(t / c),
            maxMs: round(m),
            ownAvgMs: ownAvg === null ? null : round(ownAvg),
          });
          calls += c;
          errors += e;
          totalMs += t;
          if (ownAvg !== null) ownMs = (ownMs ?? 0) + ownAvg * c;
        }
        if (calls === 0) continue;
        methods.sort(
          (a, b) =>
            b.totalMs - a.totalMs ||
            (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
        );
        out.push({
          className: entry.className,
          kind: entry.kind as ClassKind,
          calls,
          errors,
          totalMs: round(totalMs),
          avgMs: round(totalMs / calls),
          ownMs: ownMs === null ? null : round(ownMs),
          methods,
        });
      }
      out.sort(
        (a, b) =>
          b.totalMs - a.totalMs ||
          (a.className < b.className ? -1 : a.className > b.className ? 1 : 0),
      );
    } catch {
      out.length = 0;
    }
    return {
      windowMinutes: window,
      fromUnixMs: first * BUCKET_MS,
      toUnixMs: now,
      methodsEnabled,
      classes: out,
    };
  }

  private seriesFor(
    className: string,
    kind: MethodClassKind,
    method: string,
  ): MethodSeries {
    let entry = this.classes.get(className);
    if (entry === undefined) {
      if (this.classes.size >= MAX_CLASSES) {
        this.other ??= new ClassEntry(OTHER, "provider");
        this.other.other ??= new MethodSeries(OTHER);
        return this.other.other;
      }
      entry = new ClassEntry(className, kind);
      this.classes.set(className, entry);
    }
    const found = entry.methods.get(method);
    if (found !== undefined) return found;
    if (entry.methods.size >= MAX_METHODS_PER_CLASS) {
      entry.other ??= new MethodSeries(OTHER);
      return entry.other;
    }
    const created = new MethodSeries(method);
    entry.methods.set(method, created);
    return created;
  }
}

/**
 * Average own time per (class, method) from stored spans: for each span carrying `nestrix.class`
 * and `nestrix.method` that started at or after `fromUnixMs`, its duration minus the summed
 * durations of its direct children in the same trace, clipped at 0. `scan` visits the stored
 * traces (`TraceStore.scanTraces`). Never throws.
 */
export function ownAverages(
  scan: (visit: (spans: readonly SpanRecord[]) => void) => void,
  fromUnixMs: number,
): OwnAverages {
  const sums = new Map<string, Map<string, { sum: number; n: number }>>();
  try {
    scan((spans) => {
      let childTotals: Map<string, number> | undefined;
      for (const span of spans) {
        if (span.parentSpanId === undefined) continue;
        childTotals ??= new Map();
        childTotals.set(
          span.parentSpanId,
          (childTotals.get(span.parentSpanId) ?? 0) + span.durationMs,
        );
      }
      for (const span of spans) {
        if (span.startTimeUnixMs < fromUnixMs) continue;
        const cls = span.attributes[ATTR_CLASS];
        const method = span.attributes[ATTR_METHOD];
        if (typeof cls !== "string" || typeof method !== "string") continue;
        const own = Math.max(
          0,
          span.durationMs - (childTotals?.get(span.spanId) ?? 0),
        );
        let byMethod = sums.get(cls);
        if (byMethod === undefined) {
          byMethod = new Map();
          sums.set(cls, byMethod);
        }
        const acc = byMethod.get(method);
        if (acc === undefined) byMethod.set(method, { sum: own, n: 1 });
        else {
          acc.sum += own;
          acc.n++;
        }
      }
    });
  } catch {
    // Own time is an estimate; a fault leaves it out.
  }
  const out = new Map<string, Map<string, number>>();
  for (const [cls, byMethod] of sums) {
    const m = new Map<string, number>();
    for (const [method, acc] of byMethod) m.set(method, acc.sum / acc.n);
    out.set(cls, m);
  }
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
