// `TraceSummary.hasJob` and the `type=job` filter: "Jobs" means "traces that include job
// processing", whatever the root. No OpenTelemetry globals are touched.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProcessor } from "../src/store/processor.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type TraceStore,
} from "../src/store/store.js";
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

const ids = (store: TraceStore, query = {}) =>
  store
    .listTraces({ limit: 50, ...query })
    .items.map((t) => t.traceId)
    .sort();

describe("hasJob", () => {
  it("flips when a job span arrives in a later drain; type=job matches any root, type=http stays root-based", () => {
    const { store, end } = attached();
    const request = serverRoot(1);
    const plain = serverRoot(2);
    end(request, plain);
    const item = (n: number) =>
      store
        .listTraces({ limit: 50 })
        .items.find((t) => t.traceId === traceId(n));
    expect(item(1)?.hasJob).toBe(false);
    expect(ids(store, { type: "job" })).toEqual([]);

    // The job finishes after the request's spans were drained: a consumer child of the request.
    end(
      fakeSpan({
        trace: 1,
        kind: 4,
        name: "orders process",
        parent: { spanId: request.spanContext().spanId },
      }),
    );
    expect(item(1)?.hasJob).toBe(true);
    expect(item(2)?.hasJob).toBe(false);
    // The `@Processor` method span (entry attribute) counts as well.
    end(
      fakeSpan({
        trace: 2,
        name: "Mailer.send",
        attributes: { "nestrix.entry": "job" },
        parent: { spanId: plain.spanContext().spanId },
      }),
    );
    expect(item(2)?.hasJob).toBe(true);
    // A later non-job span does not clear it.
    end(
      fakeSpan({
        trace: 1,
        name: "after",
        parent: { spanId: request.spanContext().spanId },
      }),
    );
    expect(item(1)?.hasJob).toBe(true);

    // The root is still the request: type is unchanged.
    expect(item(1)?.type).toBe("http");
    expect(ids(store, { type: "job" })).toEqual([traceId(1), traceId(2)]);
    expect(ids(store, { type: "http" })).toEqual([traceId(1), traceId(2)]);
  });

  it("a job-rooted trace has hasJob; a scheduled or other one does not", () => {
    const { store, end } = attached();
    end(
      fakeSpan({ trace: 3, kind: 4 }),
      fakeSpan({ trace: 4, attributes: { "nestrix.entry": "scheduled" } }),
      fakeSpan({ trace: 5 }),
    );
    const byId = new Map(
      store.listTraces({ limit: 50 }).items.map((t) => [t.traceId, t.hasJob]),
    );
    expect(byId.get(traceId(3))).toBe(true);
    expect(byId.get(traceId(4))).toBe(false);
    expect(byId.get(traceId(5))).toBe(false);
    expect(ids(store, { type: "scheduled" })).toEqual([traceId(4)]);
    expect(ids(store, { type: "job" })).toEqual([traceId(3)]);
  });
});
