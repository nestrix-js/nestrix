/** Limits of the dashboard's trace store. The defaults were set from measurement (P2-12). */

export interface StoreLimits {
  /** Traces kept, listed or not. */
  readonly maxTraces: number;
  /** Approximate bytes kept (see `record.ts` for the estimate). */
  readonly maxBytes: number;
}

/**
 * Set from measurement (P2-12; `benchmarks/results/dashboard.md`, darwin-arm64, Node 26.13).
 * Heap per stored trace after a forced GC: about 1.4 KB for a server span alone, 4.0 KB for a
 * server span plus 5 client spans (the typical shape), 27.8 KB for 51 spans with attributes and an
 * exception (decimal KB, as in the README). The store's estimate is 1.12x to 1.22x those figures.
 *
 * - `maxBytes` 32 MiB (an estimate, so at most about 28 MiB of real heap) is the ceiling. Heavy
 *   traces reach it first: about 1,050 of the 51-span shape (28 MiB real).
 * - `maxTraces` 5,000 is what typical traces reach first: filling the store with that shape measured 19.5 MiB of real
 *   heap (`dashboard.md` section 2), under the ceiling. Traces with a single span use about 7 MiB at that count.
 *
 * The dashboard lists recent traces, so a few thousand is the useful depth; a larger count of
 * small traces only costs memory.
 */
export const DEFAULT_STORE_LIMITS: StoreLimits = Object.freeze({
  maxTraces: 5000,
  maxBytes: 32 * 1024 * 1024,
});

/**
 * Spans waiting for the next drain. `onEnd` drops (and counts) beyond this. One drain
 * runs per turn of the event loop, so this is only reached by a burst of more spans
 * than this ending within one turn.
 */
export const MAX_PENDING_SPANS = 4096;

/** Spans converted per drain before yielding to the event loop with another `setImmediate`. */
export const DRAIN_CHUNK = 512;

/** Keeps a usable positive integer, or falls back. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function normaliseLimits(
  limits: Partial<StoreLimits> | undefined,
): StoreLimits {
  return {
    maxTraces: positiveInt(limits?.maxTraces, DEFAULT_STORE_LIMITS.maxTraces),
    maxBytes: positiveInt(limits?.maxBytes, DEFAULT_STORE_LIMITS.maxBytes),
  };
}
