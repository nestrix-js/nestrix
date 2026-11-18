// Error occurrences and `hasErrors` in the embedded store (D-93, D-94), from spans as an exporter
// hands them over: the propagated and expected marks, spans from SDKs that do not mark
// propagation (the legacy parent rule, in either arrival order), and the trace flag and filter.
// No OpenTelemetry globals are touched.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, spanId, traceId } from "./store-helpers.js";

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

const ERROR = { code: 2 };
const exception = (message: string, marks: Record<string, unknown> = {}) => ({
  name: "exception",
  attributes: {
    "exception.type": "Error",
    "exception.message": message,
    "exception.stacktrace": `Error: ${message}\n    at here (app.js:1:1)`,
    ...marks,
  },
});

function request(trace: number, opts: { status?: number; error?: boolean }) {
  const id = spanId();
  return {
    id,
    span: (events: ReturnType<typeof exception>[] = []) =>
      fakeSpan({
        trace,
        id,
        kind: 1,
        name: "GET /x",
        attributes: {
          "http.request.method": "GET",
          "http.route": "/x",
          "http.response.status_code": opts.status ?? 200,
        },
        status: opts.error ? ERROR : { code: 0 },
        events,
      }),
  };
}

describe("error occurrences", () => {
  it("propagated and expected exceptions are not occurrences; the deepest span is", () => {
    const { store, end } = attached();
    const root = request(1, { status: 500, error: true });
    const method = fakeSpan({
      trace: 1,
      parent: { spanId: root.id },
      name: "AppController.boom",
      status: ERROR,
      events: [exception("boom")],
    });
    end(
      method,
      root.span([exception("boom", { "nestrix.exception.propagated": true })]),
    );
    const notFound = request(2, { status: 404 });
    end(
      fakeSpan({
        trace: 2,
        parent: { spanId: notFound.id },
        name: "AppController.find",
        status: ERROR,
        events: [exception("nope", { "nestrix.exception.expected": true })],
      }),
      notFound.span([
        exception("nope", { "nestrix.exception.expected": true }),
      ]),
    );
    const items = store.listErrors({ limit: 50 }).items;
    expect(items.map((i) => [i.traceId, i.spanName, i.message])).toEqual([
      [traceId(1), "AppController.boom", "boom"],
    ]);
    expect(store.stats().errorItems).toBe(1);
  });

  it("a span with error status and no exception event is an occurrence (a 5xx answered without a throw)", () => {
    const { store, end } = attached();
    end(request(3, { status: 503, error: true }).span());
    expect(store.listErrors({ limit: 50 }).items).toHaveLength(1);
  });

  it("legacy spans (no marks): a parent with the same exception as its error child is not counted, in either order", () => {
    const { store, end } = attached();
    const childFirst = request(4, { status: 500, error: true });
    end(
      fakeSpan({
        trace: 4,
        parent: { spanId: childFirst.id },
        name: "child first",
        status: ERROR,
        events: [exception("legacy")],
      }),
    );
    end(childFirst.span([exception("legacy")]));
    const parentFirst = request(5, { status: 500, error: true });
    end(parentFirst.span([exception("legacy")]));
    end(
      fakeSpan({
        trace: 5,
        parent: { spanId: parentFirst.id },
        name: "parent first",
        status: ERROR,
        events: [exception("legacy")],
      }),
    );
    // A different error on the parent stays a second occurrence.
    const different = request(6, { status: 500, error: true });
    end(
      fakeSpan({
        trace: 6,
        parent: { spanId: different.id },
        name: "inner",
        status: ERROR,
        events: [exception("inner")],
      }),
      different.span([exception("outer")]),
    );
    const items = store.listErrors({ limit: 50 }).items;
    const names = (n: number) =>
      items.filter((i) => i.traceId === traceId(n)).map((i) => i.spanName);
    expect(names(4)).toEqual(["child first"]);
    expect(names(5)).toEqual(["parent first"]);
    expect(names(6).sort()).toEqual(["GET /x", "inner"]);
    expect(store.stats().errorItems).toBe(4);
  });
});

describe("hasErrors", () => {
  it("any failed span marks the trace; expected-only spans do not; the filter matches it", () => {
    const { store, end } = attached();
    const job = request(7, {});
    end(
      fakeSpan({
        trace: 7,
        parent: { spanId: job.id },
        kind: 4,
        name: "process orders",
        status: ERROR,
        events: [exception("job failed")],
      }),
      job.span(),
    );
    const expected = request(8, { status: 404 });
    end(
      fakeSpan({
        trace: 8,
        parent: { spanId: expected.id },
        name: "AppController.find",
        status: ERROR,
        events: [exception("nope", { "nestrix.exception.expected": true })],
      }),
      expected.span([
        exception("nope", { "nestrix.exception.expected": true }),
      ]),
    );
    end(request(9, { status: 500, error: true }).span());
    end(request(10, {}).span());
    const item = (n: number) =>
      store
        .listTraces({ limit: 50 })
        .items.find((t) => t.traceId === traceId(n));
    expect(item(7)).toMatchObject({ error: false, hasErrors: true });
    expect(item(8)).toMatchObject({ error: false, hasErrors: false });
    expect(item(9)).toMatchObject({ error: true, hasErrors: true });
    expect(item(10)).toMatchObject({ error: false, hasErrors: false });
    const ids = (hasErrors: boolean) =>
      store
        .listTraces({ limit: 50, hasErrors })
        .items.map((t) => t.traceId)
        .sort();
    expect(ids(true)).toEqual([traceId(7), traceId(9)]);
    expect(ids(false)).toEqual([traceId(10), traceId(8)].sort());
    // `status=error` is still the root's outcome only.
    expect(
      store
        .listTraces({ limit: 50, status: "error" })
        .items.map((t) => t.traceId),
    ).toEqual([traceId(9)]);
  });
});
