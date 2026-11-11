/**
 * The span processor that feeds the store. Duck-typed: a plain object with the four
 * methods, no SDK class extended or checked with `instanceof`, so it works on a host's
 * provider from any copy of SDK 3 (architecture §4.5).
 *
 * It runs inside host code: the SDK does not guard processor calls, so a throw from
 * `onEnd` reaches the code that ended the span (a host's request handler returned 500
 * in P0-S3), and a rejected `forceFlush`/`shutdown` rejects the host's own. Every
 * method catches everything; `forceFlush` and `shutdown` always resolve.
 */
import type { SpanProcessor } from "@opentelemetry/sdk-trace";
import type { TraceStore } from "./store.js";

export function createStoreProcessor(store: TraceStore): SpanProcessor {
  let closed = false;
  return {
    onStart() {
      // Nothing: the store reads spans when they end.
    },
    onEnd(span) {
      try {
        if (!closed) store.enqueue(span);
      } catch {
        // enqueue never throws; this guards against a broken store object.
      }
    },
    forceFlush() {
      try {
        store.drainNow();
      } catch {
        // Never rejects.
      }
      return Promise.resolve();
    },
    shutdown() {
      try {
        if (!closed) {
          closed = true;
          store.drainNow();
        }
      } catch {
        // Never rejects.
      }
      return Promise.resolve();
    },
  };
}

/** For when even creating the store failed: accepts everything, does nothing. */
export function noopProcessor(): SpanProcessor {
  return {
    onStart() {},
    onEnd() {},
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
