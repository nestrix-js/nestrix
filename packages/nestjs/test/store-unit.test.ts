// The dashboard store and its span processor, fed with structural span objects (as any
// copy of SDK 3 produces them) and malformed ones. No OpenTelemetry globals are touched.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RedactableSpan } from "../src/options.js";
import { MAX_PENDING_SPANS } from "../src/store/limits.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type StoreRedaction,
  type TraceStore,
} from "../src/store/store.js";
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
afterEach(() => {
  resetStoreForTests();
});

function attached(
  limits?: { maxTraces?: number; maxBytes?: number },
  redaction: StoreRedaction = {},
) {
  const store = getOrCreateStore(limits ?? {}, diagnostics);
  const detach = store.attach(redaction);
  const processor = createStoreProcessor(store);
  const end = (...spans: ReadableSpan[]) => {
    for (const span of spans) processor.onEnd(span);
    store.drainNow();
  };
  return { store, processor, detach, end };
}

const ids = (store: TraceStore, query = {}) =>
  store.listTraces({ limit: 50, ...query }).items.map((t) => t.traceId);

describe("request path", () => {
  it("onEnd only enqueues; one setImmediate drain converts the whole batch", async () => {
    const { store, processor } = attached();
    processor.onEnd(serverRoot(1));
    processor.onEnd(serverRoot(2));
    expect(store.stats().receivedSpans).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.stats()).toMatchObject({ receivedSpans: 2, listedTraces: 2 });
  });

  it("stores nothing while no app is attached, and stops when the last detaches", async () => {
    const store = getOrCreateStore({}, diagnostics);
    const processor = createStoreProcessor(store);
    processor.onEnd(serverRoot(1));
    await processor.forceFlush();
    expect(store.stats()).toMatchObject({ receivedSpans: 0, traces: 0 });

    const detachA = store.attach({});
    const detachB = store.attach({});
    detachA();
    detachA(); // idempotent: B stays attached
    processor.onEnd(serverRoot(2));
    await processor.forceFlush();
    expect(store.stats().traces).toBe(1);
    detachB();
    processor.onEnd(serverRoot(3));
    await processor.forceFlush();
    expect(store.stats()).toMatchObject({ traces: 1, attached: 0 });
  });

  it("drops and counts beyond the pending bound", async () => {
    const { store, processor } = attached({ maxTraces: 10 });
    const span = serverRoot(1);
    for (let i = 0; i < MAX_PENDING_SPANS + 7; i++) processor.onEnd(span);
    expect(store.stats().queueDroppedSpans).toBe(7);
    await processor.forceFlush();
    expect(store.stats()).toMatchObject({
      receivedSpans: MAX_PENDING_SPANS,
      droppedSpans: 7,
    });
  });

  it("an onEnd given malformed span-like objects does not throw, and the store keeps working", async () => {
    const { store, processor } = attached();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("get trap");
        },
        has() {
          throw new Error("has trap");
        },
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      },
    );
    const good = serverRoot(9);
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      "span",
      {},
      hostile,
      { spanContext: () => ({ traceId: "nope", spanId: "nope" }) },
      {
        spanContext() {
          throw new Error("spanContext throws");
        },
      },
      // Valid identity, unusable times.
      {
        ...good,
        spanContext: () => ({ traceId: traceId(10), spanId: spanId() }),
        startTime: "x",
      },
      // Valid identity, attributes that throw when enumerated.
      {
        ...good,
        spanContext: () => ({ traceId: traceId(11), spanId: spanId() }),
        attributes: hostile,
      },
      // Valid identity, no status.
      {
        ...good,
        spanContext: () => ({ traceId: traceId(12), spanId: spanId() }),
        status: undefined,
      },
    ];
    for (const span of malformed) {
      expect(() => processor.onEnd(span as ReadableSpan)).not.toThrow();
      expect(() =>
        processor.onStart(span as never, undefined as never),
      ).not.toThrow();
    }
    // Through the real setImmediate drain: a throw there would be an uncaught exception,
    // which fails this test run.
    await new Promise((resolve) => setImmediate(resolve));
    processor.onEnd(good);
    await processor.forceFlush();
    const stats = store.stats();
    expect(stats.invalidSpans + stats.redactFailedSpans).toBe(malformed.length);
    expect(stats.listedTraces).toBe(1);
    expect(ids(store)).toEqual([traceId(9)]);
  });

  it("a processor over a store that throws never throws or rejects", async () => {
    const broken = new Proxy({} as TraceStore, {
      get() {
        throw new Error("broken store");
      },
    });
    const processor = createStoreProcessor(broken);
    expect(() => processor.onEnd(serverRoot(1))).not.toThrow();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it("ignores spans after shutdown", async () => {
    const { store, processor } = attached();
    await processor.shutdown();
    processor.onEnd(serverRoot(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.stats().receivedSpans).toBe(0);
  });
});

describe("traces", () => {
  it("lists a trace when its local root ends; children ending earlier wait for it", () => {
    const { store, end } = attached();
    const root = spanId();
    end(
      fakeSpan({
        trace: 1,
        parent: { spanId: root },
        name: "child",
        startMs: 1_000,
      }),
    );
    expect(ids(store)).toEqual([]);
    // Readable before it is listed, with a stand-in root.
    expect(store.getTrace(traceId(1))?.spans).toHaveLength(1);
    end(serverRoot(1, { id: root, startMs: 999, durationMs: 10 }));
    const [summary] = store.listTraces({ limit: 10 }).items;
    expect(summary).toMatchObject({
      traceId: traceId(1),
      rootSpanId: root,
      name: "GET /items/:id",
      method: "GET",
      route: "/items/:id",
      statusCode: 200,
      error: false,
      durationMs: 10,
      spanCount: 2,
    });
  });

  it("appends late child spans to a listed trace without moving it in the list", () => {
    const { store, end } = attached();
    const root = spanId();
    end(
      serverRoot(1, { id: root, startMs: 1_000 }),
      serverRoot(2, { startMs: 2_000 }),
    );
    expect(ids(store)).toEqual([traceId(2), traceId(1)]);
    const before = store.listTraces({ limit: 10 }).head;
    end(
      fakeSpan({
        trace: 1,
        parent: { spanId: root },
        name: "late",
        startMs: 1_001,
      }),
    );
    expect(ids(store)).toEqual([traceId(2), traceId(1)]);
    expect(store.listTraces({ limit: 10 }).items[1]?.spanCount).toBe(2);
    expect(store.getTrace(traceId(1))?.spans.map((s) => s.name)).toEqual([
      "GET /items/:id",
      "late",
    ]);
    // Not a new item for a poller.
    expect(store.listTraces({ limit: 10, after: before ?? "" }).items).toEqual(
      [],
    );
  });

  it("treats a span with a remote parent as the local root and keeps the parent id", () => {
    const { store, end } = attached();
    const remoteParent = "abcdefabcdefabcd";
    const local = spanId();
    end(fakeSpan({ trace: 1, parent: { spanId: local }, name: "db" }));
    expect(ids(store)).toEqual([]);
    end(
      serverRoot(1, {
        id: local,
        parent: { spanId: remoteParent, isRemote: true },
      }),
    );
    expect(store.listTraces({ limit: 10 }).items[0]?.rootSpanId).toBe(local);
    const trace = store.getTrace(traceId(1));
    expect(trace?.rootSpanId).toBe(local);
    expect(trace?.spans.find((s) => s.spanId === local)?.parentSpanId).toBe(
      remoteParent,
    );
  });

  it("an earlier-starting local root replaces the first one ended (a service calling itself)", () => {
    const { store, end } = attached();
    const outer = spanId();
    const inner = spanId();
    end(
      serverRoot(1, {
        id: inner,
        parent: { spanId: spanId(), isRemote: true },
        startMs: 1_010,
      }),
    );
    expect(store.listTraces({ limit: 1 }).items[0]?.rootSpanId).toBe(inner);
    end(serverRoot(1, { id: outer, startMs: 1_000, durationMs: 50 }));
    expect(store.listTraces({ limit: 1 }).items[0]).toMatchObject({
      rootSpanId: outer,
      durationMs: 50,
    });
  });

  it("a service calling itself: the inner server span never becomes the root, even at the same start time", () => {
    const { store, end } = attached();
    const outer = spanId();
    const client = spanId();
    const inner = spanId();
    // Start times tie (clock resolution), and the inner span ends first.
    end(
      serverRoot(1, {
        id: inner,
        parent: { spanId: client, isRemote: true },
        name: "GET /hello",
        startMs: 1_000,
        durationMs: 1,
      }),
    );
    expect(store.listTraces({ limit: 10 }).items).toHaveLength(1);
    const listed = store.listTraces({ limit: 10 }).items[0];
    // Documented: until the true root is stored, the summary follows the span that ended.
    expect(listed?.rootSpanId).toBe(inner);
    end(
      fakeSpan({
        trace: 1,
        id: client,
        parent: { spanId: outer },
        kind: 2,
        name: "GET",
        startMs: 1_000,
        durationMs: 3,
      }),
    );
    expect(store.listTraces({ limit: 10 }).items[0]?.name).toBe("GET /hello");
    end(
      serverRoot(1, {
        id: outer,
        name: "GET /out",
        startMs: 1_000,
        durationMs: 5,
      }),
    );
    const { items } = store.listTraces({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      rootSpanId: outer,
      name: "GET /out",
      durationMs: 5,
      spanCount: 3,
      cursor: listed?.cursor,
    });
    expect(store.getTrace(traceId(1))?.rootSpanId).toBe(outer);
  });

  it("copies the record into the query API's shape", () => {
    const { store, end } = attached();
    end(
      fakeSpan({
        trace: 1,
        name: "work",
        kind: 2,
        startMs: 1_700_000_000_123.5,
        durationMs: 2.25,
        attributes: {
          a: "x",
          n: 1,
          arr: ["p", null, "q"],
          bad: { nested: true },
        },
        events: [
          { name: "e", timeMs: 1_700_000_000_124, attributes: { k: "v" } },
        ],
        status: { code: 1 },
        scope: "my-lib",
        resource: { "service.name": "svc", weird: { no: 1 } },
      }),
    );
    const trace = store.getTrace(traceId(1));
    expect(trace?.resource).toEqual({ "service.name": "svc" });
    const [span] = trace?.spans ?? [];
    expect(span).toEqual({
      spanId: span?.spanId,
      name: "work",
      kind: "client",
      startTimeUnixMs: 1_700_000_000_123.5,
      durationMs: 2.25,
      attributes: { a: "x", n: 1, arr: ["p", "q"] },
      events: [
        { name: "e", timeUnixMs: 1_700_000_000_124, attributes: { k: "v" } },
      ],
      status: { code: "ok" },
      links: [],
      scope: "my-lib",
    });
  });
});

describe("trace order", () => {
  it("orders by start time, and a parent before its descendants on a tie", () => {
    const { store, end } = attached();
    const [root, child, grandchild] = [spanId(), spanId(), spanId()];
    end(
      fakeSpan({
        trace: 1,
        id: grandchild,
        parent: { spanId: child },
        name: "c",
        startMs: 1_000,
      }),
      fakeSpan({
        trace: 1,
        id: child,
        parent: { spanId: root },
        name: "b",
        startMs: 1_000,
      }),
      fakeSpan({
        trace: 1,
        name: "late-sibling",
        parent: { spanId: root },
        startMs: 1_001,
      }),
      serverRoot(1, { id: root, name: "a", startMs: 1_000 }),
    );
    expect(store.getTrace(traceId(1))?.spans.map((s) => s.name)).toEqual([
      "a",
      "b",
      "c",
      "late-sibling",
    ]);
  });

  it("survives a forged parent cycle", () => {
    const { store, end } = attached();
    const [x, y] = [spanId(), spanId()];
    end(
      fakeSpan({ trace: 1, id: x, parent: { spanId: y } }),
      fakeSpan({ trace: 1, id: y, parent: { spanId: x } }),
    );
    expect(store.getTrace(traceId(1))?.spans).toHaveLength(2);
  });
});

describe("eviction", () => {
  it("evicts the oldest trace first by count", () => {
    const { store, end } = attached({ maxTraces: 3 });
    for (let t = 1; t <= 5; t++) end(serverRoot(t));
    expect(ids(store)).toEqual([traceId(5), traceId(4), traceId(3)]);
    expect(store.getTrace(traceId(1))).toBeUndefined();
    expect(store.stats()).toMatchObject({
      traces: 3,
      evictedTraces: 2,
      spans: 3,
    });
  });

  it("evicts the oldest trace first by approximate bytes", () => {
    const probe = attached();
    probe.end(serverRoot(1));
    const oneTrace = probe.store.stats().bytes;
    resetStoreForTests();

    const { store, end } = attached({
      maxTraces: 1000,
      maxBytes: oneTrace * 3 + 10,
    });
    for (let t = 1; t <= 6; t++) end(serverRoot(t));
    const stats = store.stats();
    expect(stats.traces).toBe(3);
    expect(stats.bytes).toBeLessThanOrEqual(oneTrace * 3 + 10);
    expect(stats.evictedTraces).toBe(3);
    expect(ids(store)).toEqual([traceId(6), traceId(5), traceId(4)]);
    // Bytes return to zero-based accounting: evicting gives back what inserting took.
    expect(stats.bytes).toBe(oneTrace * 3);
  });

  it("drops a span larger than the whole byte limit without evicting anything", () => {
    const { store, end } = attached({ maxBytes: 4_000 });
    end(serverRoot(1));
    end(fakeSpan({ trace: 2, attributes: { big: "x".repeat(10_000) } }));
    expect(store.stats()).toMatchObject({
      traces: 1,
      oversizeSpans: 1,
      evictedTraces: 0,
    });
    expect(diagnostics.logs.has("store.oversize")).toBe(true);
  });
});

describe("cursors", () => {
  it("pages backwards and forwards with eviction in between", () => {
    const { store, end } = attached({ maxTraces: 10 });
    for (let t = 1; t <= 10; t++) end(serverRoot(t));

    const first = store.listTraces({ limit: 3 });
    expect(first.items.map((i) => i.traceId)).toEqual([
      traceId(10),
      traceId(9),
      traceId(8),
    ]);
    expect(first.head).toBe(first.items[0]?.cursor);
    const second = store.listTraces({ limit: 3, before: first.older ?? "" });
    expect(second.items.map((i) => i.traceId)).toEqual([
      traceId(7),
      traceId(6),
      traceId(5),
    ]);
    const cursorOf2 = store.listTraces({
      limit: 1,
      before: store.listTraces({ limit: 9 }).older ?? "",
    }).items[0]?.cursor;
    expect(cursorOf2).toBeDefined();

    // Four new traces evict traces 1 to 4.
    for (let t = 11; t <= 14; t++) end(serverRoot(t));

    // Forwards from the old head: exactly the four new ones, no reset.
    const poll = store.listTraces({ limit: 50, after: first.head ?? "" });
    expect(poll.reset).toBe(false);
    expect(poll.items.map((i) => i.traceId)).toEqual([
      traceId(14),
      traceId(13),
      traceId(12),
      traceId(11),
    ]);
    expect(poll.older).toBeNull();
    // Nothing newer than the new head.
    expect(
      store.listTraces({ limit: 50, after: poll.head ?? "" }).items,
    ).toEqual([]);

    // Backwards from trace 5 (still stored): what is older is gone; the end of the store.
    const tail = store.listTraces({ limit: 3, before: second.older ?? "" });
    expect(tail).toMatchObject({ items: [], older: null, reset: false });
    expect(
      store
        .listTraces({ limit: 3, before: second.items[1]?.cursor ?? "" })
        .items.map((i) => i.traceId),
    ).toEqual([traceId(5)]);

    // Backwards from an evicted trace: reset, newest page.
    const gone = store.listTraces({ limit: 2, before: cursorOf2 ?? "" });
    expect(gone.reset).toBe(true);
    expect(gone.items.map((i) => i.traceId)).toEqual([
      traceId(14),
      traceId(13),
    ]);
    expect(gone.older).toBe(gone.items[1]?.cursor);
  });

  it("does not reset a poll because a newer listed trace was evicted", () => {
    const { store, end } = attached({ maxTraces: 3 });
    const late = spanId();
    // Trace 100's child arrives first, so its entry is the oldest; its root ends later.
    end(fakeSpan({ trace: 100, parent: { spanId: late } }));
    end(serverRoot(1), serverRoot(2));
    const head = store.listTraces({ limit: 10 }).head ?? "";
    end(serverRoot(100, { id: late })); // listed after the cursor
    end(serverRoot(3)); // evicts trace 100, the oldest entry
    const poll = store.listTraces({ limit: 10, after: head });
    expect(poll.reset).toBe(false);
    // Trace 100 was listed and evicted; the client never saw it and cannot now.
    expect(poll.items.map((i) => i.traceId)).toEqual([traceId(3)]);
  });

  it("resets a poll whose cursor item was evicted", () => {
    const { store, end } = attached({ maxTraces: 2 });
    end(serverRoot(1));
    const head = store.listTraces({ limit: 10 }).head ?? "";
    end(serverRoot(2), serverRoot(3)); // evicts trace 1
    const poll = store.listTraces({ limit: 10, after: head });
    expect(poll.reset).toBe(true);
    expect(poll.items.map((i) => i.traceId)).toEqual([traceId(3), traceId(2)]);
  });

  it("resets a poll with more new items than one page", () => {
    const { store, end } = attached();
    end(serverRoot(1));
    const head = store.listTraces({ limit: 10 }).head ?? "";
    for (let t = 2; t <= 6; t++) end(serverRoot(t));
    const poll = store.listTraces({ limit: 3, after: head });
    expect(poll.reset).toBe(true);
    expect(poll.items.map((i) => i.traceId)).toEqual([
      traceId(6),
      traceId(5),
      traceId(4),
    ]);
    expect(poll.older).toBe(poll.items[2]?.cursor);
  });

  it("resets cursors from another process (epoch), of another kind, or malformed", () => {
    const old = attached();
    old.end(serverRoot(1), fakeSpan({ trace: 1, status: { code: 2 } }));
    const traceCursor = old.store.listTraces({ limit: 1 }).head ?? "";
    const errorCursor = old.store.listErrors({ limit: 1 }).head ?? "";
    expect(old.store.listTraces({ limit: 5, after: traceCursor }).reset).toBe(
      false,
    );
    expect(old.store.listTraces({ limit: 5, after: errorCursor }).reset).toBe(
      true,
    );

    resetStoreForTests(); // a new process, as far as the store can tell
    const fresh = attached();
    expect(fresh.store.processId).not.toBe(old.store.processId);
    fresh.end(serverRoot(2));
    for (const cursor of [
      traceCursor,
      "",
      "garbage",
      `${fresh.store.processId}.t`,
      `${fresh.store.processId}.tzzzzzzzzzzzzzz`,
    ]) {
      const before = fresh.store.listTraces({ limit: 5, before: cursor });
      const after = fresh.store.listTraces({ limit: 5, after: cursor });
      expect([before.reset, after.reset]).toEqual([true, true]);
      expect(after.items.map((i) => i.traceId)).toEqual([traceId(2)]);
    }
    expect(fresh.store.listErrors({ limit: 5, after: errorCursor }).reset).toBe(
      true,
    );
    // A cursor for a sequence number not issued yet.
    expect(
      fresh.store.listTraces({ limit: 5, after: `${fresh.store.processId}.t9` })
        .reset,
    ).toBe(true);
  });

  it("returns an empty store as null cursors", () => {
    const { store } = attached();
    expect(store.listTraces({ limit: 5 })).toEqual({
      items: [],
      head: null,
      older: null,
      reset: false,
    });
    expect(store.listErrors({ limit: 5 })).toEqual({
      items: [],
      head: null,
      older: null,
      reset: false,
    });
  });
});

describe("filters", () => {
  it("filters the trace list by route, method, status, duration and search", () => {
    const { store, end } = attached();
    end(
      serverRoot(1, { durationMs: 5 }),
      serverRoot(2, {
        name: "POST /orders",
        durationMs: 50,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/orders",
          "http.response.status_code": 201,
        },
      }),
      serverRoot(3, {
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items/:id",
          "http.response.status_code": 404,
        },
      }),
      serverRoot(4, {
        status: { code: 2 },
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items/:id",
          "http.response.status_code": 503,
        },
      }),
      serverRoot(5, {
        status: { code: 2 },
        events: [
          { name: "exception", attributes: { "exception.type": "Error" } },
        ],
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items/:id",
          "http.response.status_code": 200,
        },
      }),
    );
    const root5 = store.listTraces({ limit: 1 }).items[0]?.rootSpanId ?? "";
    end(
      fakeSpan({ trace: 5, parent: { spanId: root5 }, name: "SELECT Widgets" }),
    );

    expect(ids(store, { route: "/orders" })).toEqual([traceId(2)]);
    expect(ids(store, { method: "post" })).toEqual([traceId(2)]);
    expect(ids(store, { status: "4xx" })).toEqual([traceId(3)]);
    expect(ids(store, { status: "5xx" })).toEqual([traceId(4)]);
    expect(ids(store, { status: "error" })).toEqual([traceId(5), traceId(4)]);
    expect(ids(store, { status: "ok" })).toEqual([traceId(2), traceId(1)]);
    expect(ids(store, { minDurationMs: 10 })).toEqual([traceId(2)]);
    expect(ids(store, { search: "widgets" })).toEqual([traceId(5)]);
    expect(ids(store, { search: "ORDERS" })).toEqual([traceId(2)]);
    expect(
      store.listTraces({ limit: 1, status: "error" }).older,
    ).not.toBeNull();
    expect(store.listTraces({ limit: 2, status: "error" }).older).toBeNull();
  });
});

describe("errors", () => {
  it("lists every stored span with error status; an exception event alone is not an error", () => {
    const { store, end } = attached();
    const root1 = spanId();
    // Trace 1: a client span with an exception event and error status ends before its 200 root.
    end(
      fakeSpan({
        trace: 1,
        parent: { spanId: root1 },
        name: "GET",
        kind: 2,
        status: { code: 2 },
        events: [
          {
            name: "exception",
            timeMs: 1_700_000_000_002,
            attributes: {
              "exception.type": "TypeError",
              "exception.message": "fetch failed",
            },
          },
        ],
      }),
    );
    // Before the root ends, the item takes route and method from the span itself (none).
    expect(store.listErrors({ limit: 5 }).items[0]?.route).toBeUndefined();
    end(serverRoot(1, { id: root1 }));
    // A thrown 404: the exception event is kept, but status is unset, so not an error.
    end(
      serverRoot(2, {
        events: [
          {
            name: "exception",
            attributes: {
              "exception.type": "NotFoundException",
              "exception.message": "Not Found",
            },
          },
        ],
        attributes: {
          "http.request.method": "GET",
          "http.route": "/x",
          "http.response.status_code": 404,
        },
      }),
    );
    // A 500 with error status and no exception event.
    end(
      serverRoot(3, {
        status: { code: 2, message: "Internal Server Error" },
        attributes: {
          "http.request.method": "PUT",
          "http.route": "/y",
          "http.response.status_code": 500,
        },
      }),
    );
    // An internal span with error status in a trace whose root has not ended.
    end(
      fakeSpan({
        trace: 4,
        parent: { spanId: spanId() },
        name: "job",
        status: { code: 2, message: "boom" },
      }),
    );

    const errors = store.listErrors({ limit: 10 });
    expect(errors.items.map((e) => [e.traceId, e.spanName])).toEqual([
      [traceId(4), "job"],
      [traceId(3), "GET /items/:id"],
      [traceId(1), "GET"],
    ]);
    expect(errors.items[2]).toMatchObject({
      spanKind: "client",
      route: "/items/:id",
      method: "GET",
      statusCode: 200,
      errorType: "TypeError",
      message: "fetch failed",
      timeUnixMs: 1_700_000_000_002,
    });
    expect(errors.items[1]).toMatchObject({
      route: "/y",
      statusCode: 500,
      errorType: "Internal Server Error",
      message: "Internal Server Error",
    });
    expect(errors.items[0]).toMatchObject({
      errorType: "boom",
      message: "boom",
    });
    expect(store.listErrors({ limit: 10, route: "/y" }).items).toHaveLength(1);
    expect(
      store
        .listTraces({ limit: 10 })
        .items.find((t) => t.traceId === traceId(3))?.error,
    ).toBe(true);
    expect(
      store
        .listTraces({ limit: 10 })
        .items.find((t) => t.traceId === traceId(1))?.error,
    ).toBe(false);
    const notFound = store
      .listTraces({ limit: 10 })
      .items.find((t) => t.traceId === traceId(2));
    expect(notFound).toMatchObject({ error: false, statusCode: 404 });
    expect(errors.items.map((e) => e.traceId)).not.toContain(traceId(2));
    expect(ids(store, { status: "error" })).toEqual([traceId(3)]);
  });

  it("removes a trace's error items when it is evicted, and pages them by cursor", () => {
    const { store, end } = attached({ maxTraces: 2 });
    for (let t = 1; t <= 4; t++) end(serverRoot(t, { status: { code: 2 } }));
    const page1 = store.listErrors({ limit: 1 });
    expect(page1.items.map((e) => e.traceId)).toEqual([traceId(4)]);
    const page2 = store.listErrors({ limit: 1, before: page1.older ?? "" });
    expect(page2).toMatchObject({ older: null, reset: false });
    expect(page2.items.map((e) => e.traceId)).toEqual([traceId(3)]);
    expect(store.stats().errorItems).toBe(2);
  });
});

describe("redaction (D-37)", () => {
  function hostHttpSpan(trace: number, name = "GET") {
    return fakeSpan({
      trace,
      name,
      kind: 2,
      scope: "@opentelemetry/instrumentation-http",
      attributes: {
        "url.full": "https://user:pw@api.example.com/a?token=abc&q=1#frag",
        "url.query": "api_key=zzz&page=2",
        "http.request.header.authorization": ["Bearer secret"],
        "http.request.header.content-type": ["application/json"],
        secret: "s3cr3t",
      },
      events: [
        {
          name: "exception",
          attributes: { "exception.message": "password=hunter2" },
        },
      ],
      status: { code: 2, message: "password=hunter2" },
    });
  }

  it("applies Nestrix's scrub step to a host instrumentation's span by default", () => {
    const { store, end } = attached();
    end(hostHttpSpan(1));
    const [span] = store.getTrace(traceId(1))?.spans ?? [];
    expect(span?.scope).toBe("@opentelemetry/instrumentation-http");
    expect(span?.attributes).toMatchObject({
      "url.full":
        "https://REDACTED:REDACTED@api.example.com/a?token=REDACTED&q=1",
      "url.query": "api_key=REDACTED&page=2",
      "http.request.header.authorization": ["REDACTED"],
      "http.request.header.content-type": ["application/json"],
    });
  });

  it("applies the app's scrub step and then its redact hook", () => {
    const seen: unknown[] = [];
    const scrub = (span: RedactableSpan) => {
      span.attributes["test.scrubbed"] = true;
    };
    const redact = (span: RedactableSpan) => {
      seen.push(span.attributes["test.scrubbed"]);
      delete span.attributes.secret;
      const event = span.events[0];
      if (event) event.attributes["exception.message"] = "[hidden]";
      span.status.message = "[hidden]";
      if (span.name === "drop-me") return false;
      return undefined;
    };
    const { store, end } = attached({}, { scrub, redact });
    end(hostHttpSpan(1), hostHttpSpan(2, "drop-me"));
    expect(seen).toEqual([true, true]);
    const [span] = store.getTrace(traceId(1))?.spans ?? [];
    expect(span?.attributes.secret).toBeUndefined();
    expect(span?.attributes["test.scrubbed"]).toBe(true);
    expect(span?.events[0]?.attributes["exception.message"]).toBe("[hidden]");
    expect(span?.status).toEqual({ code: "error", message: "[hidden]" });
    expect(store.getTrace(traceId(2))).toBeUndefined();
    expect(store.listErrors({ limit: 10 }).items.map((e) => e.message)).toEqual(
      ["[hidden]"],
    );
    expect(store.stats()).toMatchObject({
      redactDroppedSpans: 1,
      droppedSpans: 1,
    });
  });

  it("a throwing redact hook drops that span; the store keeps working", () => {
    const redact = (span: RedactableSpan) => {
      if (span.name === "boom") throw new Error("user hook fault");
      return undefined;
    };
    const { store, end } = attached({}, { redact });
    end(
      serverRoot(1, { name: "boom" }),
      serverRoot(2),
      serverRoot(3, { name: "boom" }),
      serverRoot(4),
    );
    expect(ids(store)).toEqual([traceId(4), traceId(2)]);
    expect(store.stats()).toMatchObject({
      redactFailedSpans: 2,
      droppedSpans: 2,
    });
    expect(
      diagnostics.failures.filter((f) => f.where === "store.redact"),
    ).toHaveLength(2);
  });

  it("an async redact hook fails closed and its rejection is handled", async () => {
    const redact = (() =>
      Promise.reject(new Error("async hook"))) as unknown as () => undefined;
    const { store, end } = attached({}, { redact });
    end(serverRoot(1));
    // An unhandled rejection would fail this test run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.stats()).toMatchObject({ traces: 0, redactFailedSpans: 1 });
    expect(diagnostics.logs.has("otel.redact.async")).toBe(true);
  });

  it("a hook that leaves an unusable span fails it closed", () => {
    const redact = (span: RedactableSpan) => {
      (span as { status: unknown }).status = { code: 7 };
      return undefined;
    };
    const { store, end } = attached({}, { redact });
    end(serverRoot(1));
    expect(store.stats()).toMatchObject({ traces: 0, redactFailedSpans: 1 });
  });

  it("uses the first attached app's redaction while it stays attached", () => {
    const store = getOrCreateStore({}, diagnostics);
    const processor = createStoreProcessor(store);
    const detachFirst = store.attach({ redact: () => false });
    store.attach({});
    processor.onEnd(serverRoot(1));
    store.drainNow();
    expect(store.stats().traces).toBe(0);
    detachFirst();
    processor.onEnd(serverRoot(2));
    store.drainNow();
    expect(store.stats().traces).toBe(1);
  });
});

describe("one store per process", () => {
  it("nestrixSpanProcessor() creates it with defaults; the first explicit limits apply while it is empty; later ones are logged and ignored", () => {
    nestrixSpanProcessor();
    const store = getOrCreateStore(undefined, diagnostics);
    expect(store.limits).toEqual({
      maxTraces: 5000,
      maxBytes: 32 * 1024 * 1024,
    });
    expect(store.stats().processors).toBe(1);
    expect(
      getOrCreateStore({ maxTraces: 5, maxBytes: 50_000 }, diagnostics),
    ).toBe(store);
    expect(store.limits).toEqual({ maxTraces: 5, maxBytes: 50_000 });
    getOrCreateStore({ maxTraces: 7 }, diagnostics);
    expect(store.limits.maxTraces).toBe(5);
    expect(diagnostics.logs.has("store.limits-ignored")).toBe(true);
  });

  it("falls back to the defaults for unusable limits", () => {
    const store = getOrCreateStore(
      { maxTraces: -1, maxBytes: Number.NaN },
      diagnostics,
    );
    expect(store.limits).toEqual({
      maxTraces: 5000,
      maxBytes: 32 * 1024 * 1024,
    });
  });
});
