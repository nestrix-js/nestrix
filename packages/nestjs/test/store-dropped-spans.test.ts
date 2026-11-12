// `TraceResponse.droppedSpans` (D-78) in the embedded store: read from the app's
// `nestrix.trace.spans_dropped*` attributes, summed over the trace's spans. The store has no
// per-trace cap of its own, so `byServer` is always 0.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, traceId } from "./store-helpers.js";

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

function attached() {
  const store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  const end = (...spans: ReadableSpan[]) => {
    for (const span of spans) processor.onEnd(span);
    store.drainNow();
  };
  return { store, end };
}

describe("droppedSpans in the embedded trace response", () => {
  it("sums the total and the per-kind attributes over every span of the trace", () => {
    const { store, end } = attached();
    const root = serverRoot(1, {
      attributes: {
        "http.request.method": "GET",
        "http.route": "/x",
        "nestrix.trace.spans_dropped": 15_000,
        "nestrix.trace.spans_dropped.db": 12_000,
        "nestrix.trace.spans_dropped.redis": 3_000,
      },
    });
    const job = fakeSpan({
      trace: 1,
      kind: 4,
      name: "q process",
      parent: { spanId: root.spanContext().spanId },
      attributes: {
        "nestrix.trace.spans_dropped": 20,
        "nestrix.trace.spans_dropped.db": 5,
        "nestrix.trace.spans_dropped.messaging": 15,
      },
    });
    end(root, job);
    expect(store.getTrace(traceId(1))?.droppedSpans).toEqual({
      total: 15_020,
      byKind: { db: 12_005, redis: 3_000, messaging: 15 },
      byServer: 0,
    });
  });

  it("is absent when nothing was dropped, and ignores malformed values", () => {
    const { store, end } = attached();
    end(serverRoot(1));
    end(
      serverRoot(2, {
        attributes: {
          "nestrix.trace.spans_dropped": "many",
          "nestrix.trace.spans_dropped.db": -4,
          "nestrix.trace.spans_dropped.": 9,
        },
      }),
    );
    expect(store.getTrace(traceId(1))?.droppedSpans).toBeUndefined();
    expect(store.getTrace(traceId(2))?.droppedSpans).toBeUndefined();
  });
});
