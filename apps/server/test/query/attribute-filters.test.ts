/**
 * Issue #27, D-102 on the standalone server: `NESTRIX_INDEXED_ATTRIBUTES` keys are stored per
 * trace at ingest (`traces.indexed_attributes`, migration 0017) and filter the trace list, the
 * timeline, the error list and the error groups with `attr.<key>=<value>`; a key that is not
 * listed is a 400; nothing is indexed without the variable; a recorded `x-request-id` finds its
 * trace through `search`.
 */
import "reflect-metadata";
import type {
  ErrorGroupsResponse,
  ErrorListResponse,
  MetaResponse,
  TraceListResponse,
  TraceTimelineResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { IngestSpan } from "../../src/ingest/model.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number, k = 0) => (n * 16 + k).toString(16).padStart(16, "0");
const NOW = Date.now();
const ERROR = { code: "error" as const };

function request(
  n: number,
  attributes: Record<string, unknown>,
  opts: { error?: boolean; parent?: string } = {},
): IngestSpan {
  return span({
    traceId: tid(n),
    spanId: sid(n),
    ...(opts.parent ? { parentSpanId: opts.parent } : {}),
    name: "GET /orders",
    kind: "server",
    startMs: NOW - 60_000 + n * 100,
    durationMs: 10,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": opts.error ? 500 : 200,
      ...attributes,
    } as IngestSpan["attributes"],
    ...(opts.error
      ? {
          status: ERROR,
          events: [
            {
              name: "exception",
              timeUnixNano: BigInt(NOW - 60_000 + n * 100) * 1_000_000n,
              attributes: {
                "exception.type": "Error",
                "exception.message":
                  n === 2 ? "payment declined" : "stock missing",
                "exception.stacktrace": "Error\n    at x (a.js:1:1)",
              },
            },
          ],
        }
      : {}),
  });
}

const ids = (r: { items: { traceId: string }[] }) =>
  r.items.map((i) => i.traceId).sort();

describe("NESTRIX_INDEXED_ATTRIBUTES", () => {
  const parse = (value: string) =>
    loadConfig({
      DATABASE_URL: "postgres://localhost/x",
      NESTRIX_INGEST_AUTH: "none",
      NESTRIX_INDEXED_ATTRIBUTES: value,
    });

  it("is empty by default", () => {
    const r = loadConfig({
      DATABASE_URL: "postgres://localhost/x",
      NESTRIX_INGEST_AUTH: "none",
    });
    expect(r.ok && r.config.indexedAttributes).toEqual([]);
  });

  it("takes a comma-separated list, trims and drops duplicates", () => {
    const r = parse(" tenant.id, app.client_id ,,tenant.id");
    expect(r.ok && r.config.indexedAttributes).toEqual([
      "tenant.id",
      "app.client_id",
    ]);
  });

  it("refuses malformed keys and more than 16", () => {
    const bad = parse("tenant id,ok");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join()).toMatch(
      /"tenant id" is not an attribute name/,
    );
    const many = parse(Array.from({ length: 17 }, (_, i) => `k${i}`).join(","));
    expect(!many.ok && many.errors.join()).toMatch(/at most 16/);
  });
});

describe.skipIf(noDatabase)(`attribute filters ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let plain: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("attrs");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_INDEXED_ATTRIBUTES: "tenant.id,app.seats",
    });
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("shop", [
        // 1, 2: tenant acme (2 fails); 3: tenant globex (fails); 4: no tenant.
        request(1, {
          "tenant.id": "acme",
          "app.seats": 12,
          "app.plan": "gold",
          "http.request.header.x-request-id": ["req-1111"],
        }),
        request(2, { "tenant.id": "acme" }, { error: true }),
        request(3, { "tenant.id": "globex" }, { error: true }),
        request(4, {
          "http.response.header.x-request-id": ["Req-Upper-4"],
        }),
        request(6, { "http.request.header.x-request-id": ["REDACTED"] }),
      ]),
    );
    // Trace 5: the root arrives without a tenant; a job span in a later batch brings it.
    await sink.write(batch("shop", [request(5, {})]));
    await sink.write(
      batch("worker", [
        span({
          traceId: tid(5),
          spanId: sid(5, 1),
          parentSpanId: sid(5),
          name: "process mail",
          kind: "consumer",
          startMs: NOW - 59_000,
          durationMs: 3,
          attributes: { "tenant.id": "acme" },
        }),
      ]),
    );
    // The same data in a server that lists no key: nothing is indexed.
    plain = await startQueryServer(db.url);
  });
  afterAll(async () => {
    await server?.close();
    await plain?.close();
    await db?.drop();
  });

  it("stores only the listed keys, as text, and nothing for a trace without them", async () => {
    const { rows } = await db.pool.query<{
      trace_id: string;
      indexed_attributes: Record<string, string> | null;
      request_ids: string[] | null;
    }>(
      "SELECT trace_id, indexed_attributes, request_ids FROM traces ORDER BY trace_id",
    );
    const by = new Map(rows.map((r) => [r.trace_id, r]));
    expect(by.get(tid(1))?.indexed_attributes).toEqual({
      "tenant.id": "acme",
      "app.seats": "12",
    });
    expect(by.get(tid(1))?.request_ids).toEqual(["req-1111"]);
    expect(by.get(tid(4))?.indexed_attributes).toBeNull();
    expect(by.get(tid(4))?.request_ids).toEqual(["Req-Upper-4"]);
    // A later span of the trace fills a key the root lacked.
    expect(by.get(tid(5))?.indexed_attributes).toEqual({ "tenant.id": "acme" });
    // `REDACTED` is not a request id.
    expect(by.get(tid(6))?.request_ids).toBeNull();
  });

  it("filters the trace list by one or several attributes", async () => {
    expect(
      ids(
        await server.json<TraceListResponse>(
          "/api/v1/traces?attr.tenant.id=acme",
        ),
      ),
    ).toEqual([tid(1), tid(2), tid(5)]);
    expect(
      ids(
        await server.json<TraceListResponse>(
          "/api/v1/traces?attr.tenant.id=acme&attr.app.seats=12",
        ),
      ),
    ).toEqual([tid(1)]);
    expect(
      ids(
        await server.json<TraceListResponse>(
          "/api/v1/traces?attr.tenant.id=nobody",
        ),
      ),
    ).toEqual([]);
    // An empty value is no filter.
    expect(
      (await server.json<TraceListResponse>("/api/v1/traces?attr.tenant.id="))
        .items,
    ).toHaveLength(6);
  });

  it("filters the timeline, the error list and the error groups", async () => {
    const timeline = await server.json<TraceTimelineResponse>(
      "/api/v1/traces/timeline?attr.tenant.id=globex",
    );
    const total = timeline.buckets.reduce(
      (n, b) => n + b.ok + b.clientError + b.serverError,
      0,
    );
    expect(total).toBe(1);

    const errors = await server.json<ErrorListResponse>(
      "/api/v1/errors?attr.tenant.id=acme",
    );
    expect(errors.items.map((e) => e.traceId)).toEqual([tid(2)]);

    const groups = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?attr.tenant.id=globex",
    );
    expect(groups.groups.map((g) => g.pattern)).toEqual(["stock missing"]);
    const all = await server.json<ErrorGroupsResponse>("/api/v1/errors/groups");
    expect(all.groups).toHaveLength(2);
  });

  it("answers 400 for a key that is not indexed, a fifth filter, a long value, a repeated key", async () => {
    const cases = [
      "/api/v1/traces?attr.app.plan=gold",
      "/api/v1/errors?attr.user.id=x",
      "/api/v1/errors/groups?attr.x=1",
      `/api/v1/traces?attr.tenant.id=${"a".repeat(257)}`,
      "/api/v1/traces?attr.tenant.id=a&attr.tenant.id=b",
      "/api/v1/traces?attr.a=1&attr.b=1&attr.c=1&attr.d=1&attr.e=1",
      // Routes without attribute filters keep refusing unknown parameters.
      "/api/v1/routes?attr.tenant.id=acme",
    ];
    for (const path of cases) {
      const res = await server.get(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const res = await server.get("/api/v1/traces?attr.app.plan=gold");
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("NESTRIX_INDEXED_ATTRIBUTES");
  });

  it("a value with SQL or JSON in it is a value, nothing else", async () => {
    for (const value of [`acme"}`, "' OR 1=1 --", `{"tenant.id":"acme"}`]) {
      const list = await server.json<TraceListResponse>(
        `/api/v1/traces?attr.tenant.id=${encodeURIComponent(value)}`,
      );
      expect(list.items).toEqual([]);
    }
  });

  it("lists the indexed keys in meta", async () => {
    const meta = await server.json<MetaResponse>("/api/v1/meta");
    expect(meta.attributeFilters).toEqual(["app.seats", "tenant.id"]);
    const none = await plain.json<MetaResponse>("/api/v1/meta");
    expect(none.attributeFilters).toEqual([]);
    expect((await plain.get("/api/v1/traces?attr.tenant.id=acme")).status).toBe(
      400,
    );
    // Ingested by a server that lists no key: nothing indexed.
    await plain.app
      .get(PostgresIngestSink)
      .write(batch("shop", [request(7, { "tenant.id": "acme" })]));
    const { rows } = await db.pool.query(
      "SELECT indexed_attributes FROM traces WHERE trace_id = $1",
      [tid(7)],
    );
    expect(rows).toEqual([{ indexed_attributes: null }]);
  });

  it("finds a trace by an exact recorded request id in search", async () => {
    expect(
      ids(
        await server.json<TraceListResponse>("/api/v1/traces?search=req-1111"),
      ),
    ).toEqual([tid(1)]);
    expect(
      ids(
        await server.json<TraceListResponse>(
          "/api/v1/traces?search=Req-Upper-4",
        ),
      ),
    ).toEqual([tid(4)]);
    // Exact only: a prefix is not a request id (and is not in a span name or route).
    expect(
      ids(await server.json<TraceListResponse>("/api/v1/traces?search=req-11")),
    ).toEqual([]);
    expect(
      ids(
        await server.json<TraceListResponse>("/api/v1/traces?search=REDACTED"),
      ),
    ).toEqual([]);
  });
});
