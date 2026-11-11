// P2-15: the store takes the oldest trace from its own queue, not from `Map.values().next()`,
// and checks duplicate span ids by scanning small traces and with a Set for larger ones. These
// tests pin the behaviour both must keep: eviction in first-arrival order across many
// evictions (including the queue's compaction), and a span seen twice stored once at any size.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import {
  type RecordingDiagnostics,
  recordingDiagnostics,
} from "./otel-helpers.js";
import { fakeSpan, serverRoot, spanId, traceId } from "./store-helpers.js";

let diagnostics: RecordingDiagnostics;

beforeEach(() => {
  resetStoreForTests();
  diagnostics = recordingDiagnostics();
});
afterEach(() => resetStoreForTests());

function attached(limits: { maxTraces?: number; maxBytes?: number }) {
  const store = getOrCreateStore(limits, diagnostics);
  store.attach({});
  const processor = createStoreProcessor(store);
  return { store, processor };
}

describe("eviction order", () => {
  it("keeps exactly the newest maxTraces traces after thousands of evictions", () => {
    const { store, processor } = attached({ maxTraces: 50 });
    const total = 5000; // well past the queue's compaction threshold (1,024 evicted)
    for (let t = 1; t <= total; t++) {
      processor.onEnd(serverRoot(t));
      if (t % 97 === 0) store.drainNow();
    }
    store.drainNow();
    expect(store.stats()).toMatchObject({
      traces: 50,
      evictedTraces: total - 50,
      spans: 50,
    });
    for (let t = 1; t <= total - 50; t += 311) {
      expect(store.getTrace(traceId(t))).toBeUndefined();
    }
    expect(store.getTrace(traceId(total - 50))).toBeUndefined();
    expect(store.getTrace(traceId(total - 49))).toBeDefined();
    expect(store.getTrace(traceId(total))).toBeDefined();
    const listed = store.listTraces({ limit: 100 }).items.map((i) => i.traceId);
    expect(listed).toHaveLength(50);
    expect(listed[0]).toBe(traceId(total));
    expect(listed[49]).toBe(traceId(total - 49));
  });

  it("evicts by first arrival, not by last activity", () => {
    const { store, processor } = attached({ maxTraces: 2 });
    const firstRoot = spanId();
    processor.onEnd(fakeSpan({ trace: 1, id: firstRoot }));
    processor.onEnd(serverRoot(2));
    // A later span of trace 1 does not make it younger.
    processor.onEnd(fakeSpan({ trace: 1, parent: { spanId: firstRoot } }));
    processor.onEnd(serverRoot(3));
    store.drainNow();
    expect(store.getTrace(traceId(1))).toBeUndefined();
    expect(store.getTrace(traceId(2))).toBeDefined();
    expect(store.getTrace(traceId(3))).toBeDefined();
  });

  it("a late span of an evicted trace starts a new entry that is evicted in its own turn", () => {
    const { store, processor } = attached({ maxTraces: 2 });
    processor.onEnd(serverRoot(1));
    processor.onEnd(serverRoot(2));
    processor.onEnd(serverRoot(3)); // evicts 1
    processor.onEnd(fakeSpan({ trace: 1 })); // new entry for trace 1, evicts 2
    store.drainNow();
    expect(store.getTrace(traceId(2))).toBeUndefined();
    expect(store.getTrace(traceId(3))).toBeDefined();
    expect(store.getTrace(traceId(1))?.spans).toHaveLength(1);
    processor.onEnd(serverRoot(4)); // evicts 3, the oldest entry
    store.drainNow();
    expect(store.getTrace(traceId(3))).toBeUndefined();
    expect(store.getTrace(traceId(1))).toBeDefined();
    expect(store.getTrace(traceId(4))).toBeDefined();
  });
});

describe("duplicate span ids", () => {
  it("stores a repeated span once in a small and in a large trace", () => {
    const { store, processor } = attached({});
    const rootId = spanId();
    const spans = [fakeSpan({ trace: 7, id: rootId })];
    for (let i = 0; i < 20; i++) {
      spans.push(fakeSpan({ trace: 7, parent: { spanId: rootId } }));
    }
    // Every span twice, one pass after another: duplicates arrive while the trace is
    // below the scan threshold and again once it has switched to a Set.
    for (const span of spans) processor.onEnd(span);
    for (const span of spans) processor.onEnd(span);
    store.drainNow();
    expect(store.getTrace(traceId(7))?.spans).toHaveLength(21);
    expect(store.stats()).toMatchObject({ receivedSpans: 42, spans: 21 });
  });

  it("stores a duplicate arriving at each size of a growing trace once", () => {
    const { store, processor } = attached({});
    const rootId = spanId();
    const first = fakeSpan({ trace: 8, id: rootId });
    processor.onEnd(first);
    processor.onEnd(first);
    for (let i = 1; i <= 12; i++) {
      const span = fakeSpan({ trace: 8, parent: { spanId: rootId } });
      processor.onEnd(span);
      processor.onEnd(span); // the duplicate lands at size i + 1
    }
    store.drainNow();
    expect(store.getTrace(traceId(8))?.spans).toHaveLength(13);
  });
});
