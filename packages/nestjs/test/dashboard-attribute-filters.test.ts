// Issue #27, D-102 on the embedded dashboard API: `attr.<key>=<value>` filters the trace list,
// the timeline, the error list and the error groups (the root's value, else the first span's that
// has one; numbers and booleans as text); malformed keys, a fifth filter, a long value and a
// repeated key are a 400; a recorded `x-request-id` is found by `search`. No OpenTelemetry
// globals are touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installContextPropagation,
  resetSeenTraceAttributeKeysForTests,
} from "../src/context/trace-attributes.js";
import {
  type ApiSources,
  errorGroupsHandler,
  errorsHandler,
  metaHandler,
  routesHandler,
  timelineHandler,
  tracesHandler,
} from "../src/dashboard/api.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { RouteStatistics } from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, traceId } from "./store-helpers.js";

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

const NOW = Date.now();

function failed(trace: number, message: string, attributes = {}) {
  return serverRoot(trace, {
    startMs: NOW - 5000 + trace,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": 500,
      ...attributes,
    },
    status: { code: 2, message },
    events: [
      {
        name: "exception",
        timeMs: NOW - 5000 + trace,
        attributes: {
          "exception.type": "Error",
          "exception.message": message,
          "exception.stacktrace": "Error\n    at x (a.js:1:1)",
        },
      },
    ],
  });
}

function sources(): ApiSources {
  const store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  const at = (trace: number) => NOW - 5000 + trace;
  processor.onEnd(
    serverRoot(1, {
      startMs: at(1),
      attributes: {
        "http.request.method": "GET",
        "http.route": "/orders",
        "http.response.status_code": 200,
        "tenant.id": "acme",
        "app.seats": 12,
        "app.trial": false,
        "http.request.header.x-request-id": ["req-1111"],
      },
    }),
  );
  processor.onEnd(failed(2, "payment declined", { "tenant.id": "acme" }));
  processor.onEnd(failed(3, "stock missing", { "tenant.id": "globex" }));
  // Trace 4: the root has no tenant; a child span (a job) has it.
  const root4 = serverRoot(4, {
    startMs: at(4),
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": 200,
      "http.response.header.x-request-id": ["Req-Upper-4"],
    },
  });
  processor.onEnd(root4);
  processor.onEnd(
    fakeSpan({
      trace: 4,
      parent: { spanId: root4.spanContext().spanId },
      kind: 4,
      startMs: at(4) + 1,
      attributes: { "tenant.id": "acme" },
    }),
  );
  store.drainNow();
  return {
    store,
    stats: new RouteStatistics(NOW - 60_000),
    classes: new ClassStatistics(NOW - 60_000),
    service: { name: "shop" },
    sampling: { owner: "nestrix", rate: 1 },
    hostOwnsProvider: false,
    ignoresRoutes: false,
    fallbackProcessId: "x",
  };
}

const body = (r: { body?: unknown }) => JSON.parse(r.body as string);
const ids = (r: { body?: unknown }) =>
  (body(r).items as { traceId: string }[]).map((i) => i.traceId).sort();

describe("embedded attribute filters", () => {
  it("filter the trace list by the root's value, else a span's, all filters together", () => {
    const s = sources();
    expect(ids(tracesHandler("/api/v1/traces?attr.tenant.id=acme", s))).toEqual(
      [traceId(1), traceId(2), traceId(4)],
    );
    expect(
      ids(
        tracesHandler(
          "/api/v1/traces?attr.tenant.id=acme&attr.app.seats=12&attr.app.trial=false",
          s,
        ),
      ),
    ).toEqual([traceId(1)]);
    expect(ids(tracesHandler("/api/v1/traces?attr.tenant.id=Acme", s))).toEqual(
      [],
    );
    // An empty value is no filter.
    expect(
      ids(tracesHandler("/api/v1/traces?attr.tenant.id=", s)),
    ).toHaveLength(4);
  });

  it("filter the timeline, the error list and the error groups", () => {
    const s = sources();
    const timeline = body(
      timelineHandler("/api/v1/traces/timeline?attr.tenant.id=globex", s, NOW),
    ) as {
      buckets: { ok: number; clientError: number; serverError: number }[];
    };
    expect(
      timeline.buckets.reduce(
        (n, b) => n + b.ok + b.clientError + b.serverError,
        0,
      ),
    ).toBe(1);
    expect(ids(errorsHandler("/api/v1/errors?attr.tenant.id=acme", s))).toEqual(
      [traceId(2)],
    );
    const groups = body(
      errorGroupsHandler("/api/v1/errors/groups?attr.tenant.id=globex", s, NOW),
    ) as { groups: { pattern: string }[] };
    expect(groups.groups.map((g) => g.pattern)).toEqual(["stock missing"]);
    const all = body(errorGroupsHandler("/api/v1/errors/groups", s, NOW)) as {
      groups: unknown[];
    };
    expect(all.groups).toHaveLength(2);
  });

  it("answer 400 for malformed input and leave other routes' parameters strict", () => {
    const s = sources();
    for (const path of [
      "/api/v1/traces?attr.bad%20key=1",
      "/api/v1/traces?attr.=1",
      "/api/v1/traces?attr.1abc=1",
      `/api/v1/traces?attr.tenant.id=${"a".repeat(257)}`,
      "/api/v1/traces?attr.tenant.id=a&attr.tenant.id=b",
      "/api/v1/traces?attr.a=1&attr.b=1&attr.c=1&attr.d=1&attr.e=1",
      "/api/v1/errors?attr.__proto__%20=1",
    ]) {
      expect(tracesHandler(path, s).status, path).toBe(400);
    }
    expect(errorsHandler("/api/v1/errors?attr.a=1&attr.a=2", s).status).toBe(
      400,
    );
    expect(routesHandler("/api/v1/routes?attr.tenant.id=acme", s).status).toBe(
      400,
    );
  });

  it("find a trace by an exact recorded request id, never by a prefix", () => {
    const s = sources();
    expect(ids(tracesHandler("/api/v1/traces?search=req-1111", s))).toEqual([
      traceId(1),
    ]);
    expect(ids(tracesHandler("/api/v1/traces?search=Req-Upper-4", s))).toEqual([
      traceId(4),
    ]);
    expect(ids(tracesHandler("/api/v1/traces?search=req-11", s))).toEqual([]);
  });

  it("meta lists the keys this process set or propagates, none before", () => {
    resetSeenTraceAttributeKeysForTests();
    const s = sources();
    const meta = () => body(metaHandler("/api/v1/meta", s)).attributeFilters;
    expect(meta()).toEqual([]);
    const dispose = installContextPropagation({
      keys: new Set(["tenant.id"]),
      outgoing: false,
    });
    expect(meta()).toEqual(["tenant.id"]);
    dispose();
    resetSeenTraceAttributeKeysForTests();
  });
});
