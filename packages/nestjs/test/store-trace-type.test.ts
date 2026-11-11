// P3-03: `TraceSummary.type`, `release` and `user`, and the `type`, `release` and `user`
// filters of `GET api/v1/traces`, from the store up through the query API's parameter parsing.
// No OpenTelemetry globals are touched.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseQuery,
  traceListSpec,
  tracesHandler,
} from "../src/dashboard/api.js";
import { createStoreProcessor } from "../src/store/processor.js";
import type { SpanRecord } from "../src/store/protocol-types.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type TraceStore,
  traceTypeOf,
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
  store.listTraces({ limit: 50, ...query }).items.map((t) => t.traceId);

function record(
  kind: SpanRecord["kind"],
  attributes: SpanRecord["attributes"] = {},
): SpanRecord {
  return {
    spanId: "0000000000000001",
    name: "x",
    kind,
    startTimeUnixMs: 0,
    durationMs: 0,
    attributes,
    events: [],
    status: { code: "unset" },
    links: [],
  };
}

// SpanKind numbers: 0 internal, 1 server, 2 client, 3 producer, 4 consumer.
describe("trace type", () => {
  it("classifies the root by the backlog rule", () => {
    expect(traceTypeOf(record("server"))).toBe("http");
    // A server root wins over an entry attribute.
    expect(traceTypeOf(record("server", { "nestrix.entry": "job" }))).toBe(
      "http",
    );
    expect(traceTypeOf(record("consumer"))).toBe("job");
    expect(traceTypeOf(record("internal", { "nestrix.entry": "job" }))).toBe(
      "job",
    );
    expect(
      traceTypeOf(record("consumer", { "nestrix.entry": "scheduled" })),
    ).toBe("job");
    expect(
      traceTypeOf(record("internal", { "nestrix.entry": "scheduled" })),
    ).toBe("scheduled");
    expect(traceTypeOf(record("internal"))).toBe("other");
    expect(traceTypeOf(record("client"))).toBe("other");
    expect(traceTypeOf(record("producer"))).toBe("other");
    expect(traceTypeOf(record("internal", { "nestrix.entry": "cron" }))).toBe(
      "other",
    );
  });

  it("summarises type, release and user, and leaves release and user out when absent", () => {
    const { store, end } = attached();
    end(
      serverRoot(1, {
        resource: { "service.name": "s", "service.version": "1.4.2" },
        attributes: {
          "http.request.method": "GET",
          "http.route": "/me",
          "user.id": "alice",
        },
      }),
      fakeSpan({ trace: 2, kind: 4, name: "orders process" }),
      fakeSpan({
        trace: 3,
        name: "ReportJob.run",
        attributes: { "nestrix.entry": "scheduled" },
        resource: { "service.version": "" },
      }),
      fakeSpan({ trace: 4, name: "startup", attributes: { "user.id": 7 } }),
    );
    const byId = new Map(
      store.listTraces({ limit: 50 }).items.map((i) => [i.traceId, i]),
    );
    expect(byId.get(traceId(1))).toMatchObject({
      type: "http",
      release: "1.4.2",
      user: "alice",
    });
    const job = byId.get(traceId(2));
    expect(job?.type).toBe("job");
    expect(job && "release" in job).toBe(false);
    expect(job && "user" in job).toBe(false);
    const scheduled = byId.get(traceId(3));
    expect(scheduled?.type).toBe("scheduled");
    expect(scheduled && "release" in scheduled).toBe(false); // blank version
    const other = byId.get(traceId(4));
    expect(other?.type).toBe("other");
    expect(other && "user" in other).toBe(false); // not a string
  });
});

describe("filters", () => {
  function seeded() {
    const { store, end } = attached();
    end(
      serverRoot(1, {
        resource: { "service.version": "1.0.0" },
        attributes: { "user.id": "alice" },
      }),
      serverRoot(2, {
        resource: { "service.version": "1.1.0" },
        attributes: { "user.id": "bob" },
      }),
      fakeSpan({
        trace: 3,
        kind: 4,
        resource: { "service.version": "1.1.0" },
      }),
      fakeSpan({ trace: 4, attributes: { "nestrix.entry": "scheduled" } }),
      fakeSpan({ trace: 5 }),
    );
    return store;
  }

  it("filters by type", () => {
    const store = seeded();
    expect(ids(store, { type: "http" })).toEqual([traceId(2), traceId(1)]);
    expect(ids(store, { type: "job" })).toEqual([traceId(3)]);
    expect(ids(store, { type: "scheduled" })).toEqual([traceId(4)]);
    expect(ids(store, { type: "other" })).toEqual([traceId(5)]);
  });

  it("filters by release and user, exactly", () => {
    const store = seeded();
    expect(ids(store, { release: "1.1.0" })).toEqual([traceId(3), traceId(2)]);
    expect(ids(store, { release: "1.1" })).toEqual([]);
    expect(ids(store, { user: "alice" })).toEqual([traceId(1)]);
    expect(ids(store, { user: "ALICE" })).toEqual([]);
    expect(ids(store, { user: "bob", release: "1.0.0" })).toEqual([]);
    expect(ids(store, { type: "http", release: "1.1.0", user: "bob" })).toEqual(
      [traceId(2)],
    );
  });

  it("the query API parses the new parameters and passes them to the store", () => {
    const store = seeded();
    const sources = {
      store,
      stats: {} as never,
      service: {},
      sampling: { owner: "nestrix" as const, rate: 1 },
      hostOwnsProvider: false,
      ignoresRoutes: false,
      fallbackProcessId: "x",
    };
    const list = (target: string) => {
      const r = tracesHandler(target, sources);
      return { status: r.status, body: JSON.parse(r.body as string) };
    };
    const job = list("/api/v1/traces?type=job");
    expect(job.status).toBe(200);
    expect(job.body.items.map((i: { traceId: string }) => i.traceId)).toEqual([
      traceId(3),
    ]);
    expect(job.body.items[0].type).toBe("job");
    const mine = list("/api/v1/traces?user=alice&release=1.0.0&type=http");
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      traceId: traceId(1),
      user: "alice",
      release: "1.0.0",
      type: "http",
    });
    // An empty string filter is no filter.
    expect(list("/api/v1/traces?user=").body.items).toHaveLength(5);
  });

  it("rejects an unknown type and over-long release or user with a 400 that does not echo the value", () => {
    expect(parseQuery("/x?type=cron", traceListSpec)).toEqual({
      ok: false,
      message:
        'Query parameter "type" must be one of http, job, scheduled, other.',
    });
    const release = parseQuery(`/x?release=${"r".repeat(129)}`, traceListSpec);
    expect(release).toEqual({
      ok: false,
      message: 'Query parameter "release" must be at most 128 characters.',
    });
    expect(parseQuery(`/x?release=${"r".repeat(128)}`, traceListSpec).ok).toBe(
      true,
    );
    const user = parseQuery(`/x?user=${"u".repeat(257)}`, traceListSpec);
    expect(user).toEqual({
      ok: false,
      message: 'Query parameter "user" must be at most 256 characters.',
    });
    expect(parseQuery(`/x?user=${"u".repeat(256)}`, traceListSpec).ok).toBe(
      true,
    );
  });
});
