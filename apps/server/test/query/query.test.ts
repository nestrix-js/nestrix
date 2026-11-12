/**
 * The query API against a real PostgreSQL (the container of `test/storage/global-setup.ts`):
 * spans are ingested through the writer, then every route is queried over HTTP.
 *
 * Fixture (T0 is 90 s ago; every span ends before now):
 *
 *   A  shop     GET /orders/:id 200, user u1, release 1.2.0          (6 spans, spans two services)
 *                 OrdersService.find (method span)
 *                   POST http://payments:4000/charge  -> payments POST /charge 200
 *                                                          pg query on db "pay"
 *                   pg query on db "shop"
 *   B  shop     GET /orders/:id 500, status error, exception TypeError "boom", release 1.2.0
 *   C  shop     POST /orders 404, user u2, release 1.1.0
 *   D  worker   consumer "process email" (a job)
 *   E  shop     GET /slow 200, 900 ms; calls POST https://api.stripe.com/v1/charges
 *   F  payments POST /charge 500, status error "declined"
 *
 * Traces are ingested in the order A (payments spans before shop's), B, C, D, E, F, so the
 * newest-first list is F, E, D, C, B, A.
 */
import "reflect-metadata";
import type {
  AppMapResponse,
  ClassStatsResponse,
  ErrorListResponse,
  MetaResponse,
  RouteCompareResponse,
  RouteHistogramResponse,
  RouteStatsResponse,
  TraceListResponse,
  TraceResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePartitions, utcDay } from "../../src/storage/partitions.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { signedCookie } from "../auth/helpers.js";
import { auth, JSON_TYPE, KEY, post } from "../ingest/helpers.js";
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
const sid = (n: number) => n.toString(16).padStart(16, "0");
const T0 = Date.now() - 90_000;

const A = tid(1);
const B = tid(2);
const C = tid(3);
const D = tid(4);
const E = tid(5);
const F = tid(6);

const pgAttrs = (namespace: string) => ({
  "db.system.name": "postgresql",
  "server.address": "db",
  "server.port": 5432,
  "db.namespace": namespace,
});

async function load(sink: PostgresIngestSink): Promise<void> {
  // A: payments' spans arrive first, then shop's (the root arrives last).
  await sink.write(
    batch("payments", [
      span({
        traceId: A,
        spanId: sid(4),
        parentSpanId: sid(3),
        name: "POST /charge",
        kind: "server",
        startMs: T0 + 15,
        durationMs: 40,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/charge",
          "http.response.status_code": 200,
        },
      }),
      span({
        traceId: A,
        spanId: sid(5),
        parentSpanId: sid(4),
        name: "pg.query",
        kind: "client",
        startMs: T0 + 20,
        durationMs: 10,
        attributes: pgAttrs("pay"),
      }),
    ]),
  );
  await sink.write(
    batch(
      "shop",
      [
        span({
          traceId: A,
          spanId: sid(1),
          name: "GET /orders/:id",
          kind: "server",
          startMs: T0,
          durationMs: 120,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/orders/:id",
            "http.response.status_code": 200,
            "user.id": "u1",
          },
        }),
        span({
          traceId: A,
          spanId: sid(2),
          parentSpanId: sid(1),
          name: "OrdersService.find",
          startMs: T0 + 5,
          durationMs: 80,
          attributes: {
            "nestrix.class": "OrdersService",
            "nestrix.method": "find",
            "nestrix.component": "service",
          },
        }),
        span({
          traceId: A,
          spanId: sid(3),
          parentSpanId: sid(2),
          name: "POST",
          kind: "client",
          startMs: T0 + 10,
          durationMs: 60,
          attributes: {
            "http.request.method": "POST",
            "url.full": "http://payments:4000/charge?x=1",
            "server.address": "payments",
            "server.port": 4000,
          },
        }),
        span({
          traceId: A,
          spanId: sid(6),
          parentSpanId: sid(2),
          name: "pg.query",
          kind: "client",
          startMs: T0 + 75,
          durationMs: 10,
          attributes: pgAttrs("shop"),
        }),
      ],
      { "service.version": "1.2.0" },
    ),
  );
  await sink.write(
    batch(
      "shop",
      [
        span({
          traceId: B,
          spanId: sid(10),
          name: "GET /orders/:id",
          kind: "server",
          startMs: T0 + 1000,
          durationMs: 30,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/orders/:id",
            "http.response.status_code": 500,
          },
          status: { code: "error", message: "Internal" },
          events: [
            {
              name: "exception",
              timeUnixNano: BigInt(T0 + 1010) * 1_000_000n,
              attributes: {
                "exception.type": "TypeError",
                "exception.message": "boom",
              },
            },
          ],
        }),
      ],
      { "service.version": "1.2.0" },
    ),
  );
  await sink.write(
    batch(
      "shop",
      [
        span({
          traceId: C,
          spanId: sid(20),
          name: "POST /orders",
          kind: "server",
          startMs: T0 + 2000,
          durationMs: 5,
          attributes: {
            "http.request.method": "POST",
            "http.route": "/orders",
            "http.response.status_code": 404,
            "user.id": "u2",
          },
        }),
      ],
      { "service.version": "1.1.0" },
    ),
  );
  await sink.write(
    batch("worker", [
      span({
        traceId: D,
        spanId: sid(30),
        name: "process email",
        kind: "consumer",
        startMs: T0 + 3000,
        durationMs: 15,
        status: { code: "ok" },
      }),
    ]),
  );
  await sink.write(
    batch("shop", [
      span({
        traceId: E,
        spanId: sid(40),
        name: "GET /slow",
        kind: "server",
        startMs: T0 + 4000,
        durationMs: 900,
        attributes: {
          "http.request.method": "GET",
          "http.route": "/slow",
          "http.response.status_code": 200,
        },
      }),
      span({
        traceId: E,
        spanId: sid(41),
        parentSpanId: sid(40),
        name: "POST",
        kind: "client",
        startMs: T0 + 4010,
        durationMs: 300,
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://api.stripe.com/v1/charges?a=b",
        },
      }),
    ]),
  );
  await sink.write(
    batch("payments", [
      span({
        traceId: F,
        spanId: sid(50),
        name: "POST /charge",
        kind: "server",
        startMs: T0 + 5000,
        durationMs: 7,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/charge",
          "http.response.status_code": 500,
        },
        status: { code: "error", message: "declined" },
      }),
    ]),
  );
}

const ids = (r: TraceListResponse) => r.items.map((i) => i.traceId);

describe.skipIf(noDatabase)(`query API ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("query");
    server = await startQueryServer(db.url);
    await load(server.app.get(PostgresIngestSink));
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  describe("meta", () => {
    it("describes the standalone store", async () => {
      const meta = await server.json<MetaResponse>("/api/v1/meta");
      expect(meta).toMatchObject({
        protocolVersion: 1,
        mode: "standalone",
        services: ["payments", "shop", "worker"],
        sampling: { owner: "host", rate: null },
        statistics: { windowMinutesOptions: [15, 60] },
        warnings: [],
        profiler: { available: false, running: false },
        runtime: { available: false },
      });
      expect(meta.store.traces).toBe(6);
      expect(meta.store.spans).toBe(12);
      expect(meta.store.bytes).toBeGreaterThan(0);
      expect(typeof meta.processId).toBe("string");
      expect(Math.abs(meta.serverTimeUnixMs - Date.now())).toBeLessThan(10_000);
      expect(meta.statistics.sinceUnixMs).toBeLessThanOrEqual(
        T0 + 5000 + 60_000,
      );
    });

    it("takes no parameters", async () => {
      expect((await server.get("/api/v1/meta?x=1")).status).toBe(400);
    });
  });

  describe("traces", () => {
    it("lists newest first, with the root's fields", async () => {
      const r = await server.json<TraceListResponse>("/api/v1/traces");
      expect(ids(r)).toEqual([F, E, D, C, B, A]);
      expect(r.reset).toBe(false);
      expect(r.older).toBeNull();
      expect(r.head).toBe(r.items[0]?.cursor);
      const a = r.items[5];
      expect(a).toMatchObject({
        traceId: A,
        rootSpanId: sid(1),
        name: "GET /orders/:id",
        method: "GET",
        route: "/orders/:id",
        statusCode: 200,
        error: false,
        spanCount: 6,
        type: "http",
        release: "1.2.0",
        user: "u1",
      });
      expect(a?.durationMs).toBeCloseTo(120, 3);
      expect(Math.abs((a?.startTimeUnixMs ?? 0) - T0)).toBeLessThan(1);
      expect(r.items[2]).toMatchObject({
        traceId: D,
        type: "job",
        error: false,
      });
      expect(r.items[4]).toMatchObject({
        traceId: B,
        error: true,
        statusCode: 500,
      });
    });

    it("pages back with before and forward with after", async () => {
      const first = await server.json<TraceListResponse>(
        "/api/v1/traces?limit=2",
      );
      expect(ids(first)).toEqual([F, E]);
      expect(first.older).toBe(first.items[1]?.cursor);
      const second = await server.json<TraceListResponse>(
        `/api/v1/traces?limit=2&before=${first.older}`,
      );
      expect(ids(second)).toEqual([D, C]);
      const third = await server.json<TraceListResponse>(
        `/api/v1/traces?limit=2&before=${second.older}`,
      );
      expect(ids(third)).toEqual([B, A]);
      expect(third.older).toBeNull();
      expect(third.reset).toBe(false);

      const all = await server.json<TraceListResponse>("/api/v1/traces");
      const cursorOf = (id: string) =>
        all.items.find((i) => i.traceId === id)?.cursor;
      const newer = await server.json<TraceListResponse>(
        `/api/v1/traces?after=${cursorOf(C)}`,
      );
      expect(ids(newer)).toEqual([F, E, D]);
      expect(newer.reset).toBe(false);
      const none = await server.json<TraceListResponse>(
        `/api/v1/traces?after=${all.head}`,
      );
      expect(none.items).toEqual([]);
      expect(none.reset).toBe(false);
    });

    it("answers reset with the newest page for a cursor it cannot continue", async () => {
      const all = await server.json<TraceListResponse>("/api/v1/traces");
      // More newer items than one page: a gap.
      const gap = await server.json<TraceListResponse>(
        `/api/v1/traces?limit=1&after=${all.items[5]?.cursor}`,
      );
      expect(gap.reset).toBe(true);
      expect(ids(gap)).toEqual([F]);
      const bad = await server.json<TraceListResponse>(
        "/api/v1/traces?limit=2&before=nonsense",
      );
      expect(bad.reset).toBe(true);
      expect(ids(bad)).toEqual([F, E]);
    });

    it("filters", async () => {
      const q = async (query: string) =>
        ids(await server.json<TraceListResponse>(`/api/v1/traces?${query}`));
      expect(await q("route=/orders/:id")).toEqual([B, A]);
      expect(await q("route=/nothing")).toEqual([]);
      expect(await q("method=get")).toEqual([E, B, A]);
      expect(await q("method=POST")).toEqual([F, C]);
      expect(await q("status=error")).toEqual([F, B]);
      expect(await q("status=5xx")).toEqual([F, B]);
      expect(await q("status=4xx")).toEqual([C]);
      expect(await q("status=ok")).toEqual([E, D, A]);
      expect(await q("minDurationMs=100")).toEqual([E, A]);
      expect(await q("minDurationMs=120")).toEqual([E, A]);
      expect(await q("minDurationMs=121")).toEqual([E]);
      // Route or any span name, case-insensitive.
      expect(await q("search=ORDERSSERVICE")).toEqual([A]);
      expect(await q("search=/slow")).toEqual([E]);
      expect(await q("search=nothing-matches")).toEqual([]);
      expect(await q("type=job")).toEqual([D]);
      expect(await q("type=http")).toEqual([F, E, C, B, A]);
      expect(await q("release=1.1.0")).toEqual([C]);
      expect(await q("user=u1")).toEqual([A]);
      // The service of the trace's root.
      expect(await q("service=worker")).toEqual([D]);
      expect(await q("service=payments")).toEqual([F]);
      expect(await q("service=shop")).toEqual([E, C, B, A]);
      expect(await q("service=nope")).toEqual([]);
      expect(await q("service=shop&status=error")).toEqual([B]);
      // An empty string filter is no filter.
      expect(await q("route=")).toEqual([F, E, D, C, B, A]);
    });

    it("rejects what the embedded API rejects", async () => {
      for (const query of [
        "limit=0",
        "limit=201",
        "limit=x",
        "status=bad",
        "type=bad",
        "minDurationMs=-1",
        "minDurationMs=abc",
        "unknown=1",
        "limit=1&limit=2",
        "before=a&after=b",
        `search=${"x".repeat(201)}`,
        `service=${"x".repeat(257)}`,
        "before=",
      ]) {
        const res = await server.get(`/api/v1/traces?${query}`);
        expect(res.status, query).toBe(400);
        const body = (await res.json()) as {
          error: { code: string; message: string };
        };
        expect(body.error.code).toBe("bad_request");
        expect(body.error.message).not.toContain("xxxx");
      }
    });
  });

  describe("trace", () => {
    it("returns every span of a trace across services, with its root's resource", async () => {
      const t = await server.json<TraceResponse>(`/api/v1/trace?id=${A}`);
      expect(t.traceId).toBe(A);
      expect(t.rootSpanId).toBe(sid(1));
      expect(t.resource).toMatchObject({
        "service.name": "shop",
        "service.version": "1.2.0",
      });
      expect(t.spans.map((s) => s.spanId)).toEqual([
        sid(1),
        sid(2),
        sid(3),
        sid(4),
        sid(5),
        sid(6),
      ]);
      const method = t.spans[1];
      expect(method).toMatchObject({
        name: "OrdersService.find",
        kind: "internal",
        parentSpanId: sid(1),
        status: { code: "unset" },
        scope: "test",
        links: [],
      });
      expect(method?.attributes["nestrix.class"]).toBe("OrdersService");
      expect(method?.durationMs).toBeCloseTo(80, 3);
      expect(t.spans[0]?.parentSpanId).toBeUndefined();
      // The remote child's parent is another service's span of the same trace.
      expect(t.spans[3]).toMatchObject({
        name: "POST /charge",
        parentSpanId: sid(3),
        service: "payments",
      });
      // Every span carries its own resource's service name, not the root's.
      expect(t.spans.map((s) => s.service)).toEqual([
        "shop",
        "shop",
        "shop",
        "payments",
        expect.any(String),
        expect.any(String),
      ]);
    });

    it("keeps events and the status message", async () => {
      const t = await server.json<TraceResponse>(`/api/v1/trace?id=${B}`);
      expect(t.spans).toHaveLength(1);
      const s = t.spans[0];
      expect(s?.status).toEqual({ code: "error", message: "Internal" });
      expect(s?.events).toHaveLength(1);
      expect(s?.events[0]).toMatchObject({
        name: "exception",
        attributes: {
          "exception.type": "TypeError",
          "exception.message": "boom",
        },
      });
      expect(s?.events[0]?.timeUnixMs).toBeCloseTo(T0 + 1010, 0);
    });

    it("answers 404 for an unknown trace and 400 for a bad id", async () => {
      const missing = await server.get(`/api/v1/trace?id=${tid(999)}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: {
          code: "not_found",
          message: "No trace with this id is stored.",
        },
      });
      for (const query of [
        "",
        "?id=",
        "?id=ZZ",
        `?id=${"A".repeat(32)}`,
        `?id=${A}&x=1`,
      ]) {
        const res = await server.get(`/api/v1/trace${query}`);
        expect(res.status, query).toBe(400);
      }
    });
  });

  describe("errors", () => {
    it("lists error spans newest first", async () => {
      const r = await server.json<ErrorListResponse>("/api/v1/errors");
      expect(r.items.map((i) => i.traceId)).toEqual([F, B]);
      expect(r.reset).toBe(false);
      expect(r.older).toBeNull();
      expect(r.head).toBe(r.items[0]?.cursor);
      expect(r.items[1]).toMatchObject({
        traceId: B,
        spanId: sid(10),
        spanName: "GET /orders/:id",
        spanKind: "server",
        route: "/orders/:id",
        method: "GET",
        statusCode: 500,
        errorType: "TypeError",
        message: "boom",
      });
      expect(r.items[1]?.timeUnixMs).toBeCloseTo(T0 + 1010, 0);
      // No exception event: the status message stands in.
      expect(r.items[0]).toMatchObject({
        traceId: F,
        route: "/charge",
        method: "POST",
        statusCode: 500,
        errorType: "declined",
        message: "declined",
      });
    });

    it("pages and polls with cursors", async () => {
      const first = await server.json<ErrorListResponse>(
        "/api/v1/errors?limit=1",
      );
      expect(first.items.map((i) => i.traceId)).toEqual([F]);
      expect(first.older).toBe(first.items[0]?.cursor);
      const second = await server.json<ErrorListResponse>(
        `/api/v1/errors?limit=1&before=${first.older}`,
      );
      expect(second.items.map((i) => i.traceId)).toEqual([B]);
      expect(second.older).toBeNull();
      const newer = await server.json<ErrorListResponse>(
        `/api/v1/errors?after=${second.items[0]?.cursor}`,
      );
      expect(newer.items.map((i) => i.traceId)).toEqual([F]);
      const none = await server.json<ErrorListResponse>(
        `/api/v1/errors?after=${first.head}`,
      );
      expect(none.items).toEqual([]);
      expect(none.reset).toBe(false);
      const gap = await server.json<ErrorListResponse>(
        `/api/v1/errors?limit=1&after=${second.items[0]?.cursor}`,
      );
      expect(gap.items.map((i) => i.traceId)).toEqual([F]);
      const bad = await server.json<ErrorListResponse>(
        "/api/v1/errors?before=nonsense",
      );
      expect(bad.reset).toBe(true);
      expect(bad.items).toHaveLength(2);
    });

    it("filters by route and service", async () => {
      const q = async (query: string) =>
        (
          await server.json<ErrorListResponse>(`/api/v1/errors?${query}`)
        ).items.map((i) => i.traceId);
      expect(await q("route=/orders/:id")).toEqual([B]);
      expect(await q("route=/charge")).toEqual([F]);
      expect(await q("service=shop")).toEqual([B]);
      expect(await q("service=payments")).toEqual([F]);
      expect(await q("service=worker")).toEqual([]);
    });

    it("rejects bad parameters", async () => {
      for (const query of [
        "limit=0",
        "status=error",
        "before=a&after=b",
        `route=${"x".repeat(513)}`,
      ]) {
        expect(
          (await server.get(`/api/v1/errors?${query}`)).status,
          query,
        ).toBe(400);
      }
    });
  });

  describe("routes", () => {
    it("sums the per-minute rollups over the window", async () => {
      const r = await server.json<RouteStatsResponse>("/api/v1/routes");
      expect(r.windowMinutes).toBe(15);
      expect(r.bucketMs).toBe(60_000);
      expect(r.fromUnixMs % 60_000).toBe(0);
      expect(r.toUnixMs - r.fromUnixMs).toBeGreaterThanOrEqual(14 * 60_000);
      expect(r.routes.map((x) => `${x.method} ${x.route}`)).toEqual([
        "POST /charge",
        "GET /orders/:id",
        "POST /orders",
        "GET /slow",
      ]);
      const orders = r.routes[1];
      expect(orders).toMatchObject({ count: 2, errors: 1, maxMs: 120 });
      expect(orders?.series).toHaveLength(15);
      expect(orders?.series.reduce((n, p) => n + p.count, 0)).toBe(2);
      expect(orders?.series.reduce((n, p) => n + p.errors, 0)).toBe(1);
      const busy = orders?.series.filter((p) => p.count > 0) ?? [];
      expect(busy.length).toBeGreaterThan(0);
      for (const p of busy) {
        expect(p.p50Ms).toBeGreaterThan(0);
        expect(p.p95Ms).toBeGreaterThanOrEqual(p.p50Ms as number);
      }
      for (const p of orders?.series.filter((x) => x.count === 0) ?? []) {
        expect(p.p50Ms).toBeUndefined();
      }
      expect(orders?.p50Ms).toBeGreaterThan(0);
      expect(orders?.p95Ms).toBeGreaterThanOrEqual(orders?.p50Ms as number);
      expect(orders?.p99Ms).toBeLessThanOrEqual(120);
      // One 900 ms request: every percentile sits in its histogram bucket, capped at the maximum.
      const slow = r.routes[3];
      expect(slow).toMatchObject({ count: 1, errors: 0, maxMs: 900 });
      expect(slow?.p50Ms).toBeGreaterThan(600);
      expect(slow?.p50Ms).toBeLessThanOrEqual(900);
      // A 500 response is an error even without an error status.
      expect(r.routes[0]).toMatchObject({ count: 2, errors: 1 });
    });

    it("filters by service and takes a 60 minute window", async () => {
      const p = await server.json<RouteStatsResponse>(
        "/api/v1/routes?service=payments",
      );
      expect(p.routes.map((x) => x.route)).toEqual(["/charge"]);
      expect(p.routes[0]?.count).toBe(2);
      const w = await server.json<RouteStatsResponse>(
        "/api/v1/routes?windowMinutes=60&service=shop",
      );
      expect(w.windowMinutes).toBe(60);
      expect(w.routes[0]?.series).toHaveLength(60);
      expect(w.routes.map((x) => x.route)).toEqual([
        "/orders/:id",
        "/orders",
        "/slow",
      ]);
      const none = await server.json<RouteStatsResponse>(
        "/api/v1/routes?service=worker",
      );
      expect(none.routes).toEqual([]);
      expect(none.windowMinutes).toBe(15);
    });

    it("rejects bad parameters", async () => {
      for (const query of [
        "windowMinutes=30",
        "windowMinutes=x",
        "windowMinutes=15&windowMinutes=60",
        "limit=1",
      ]) {
        expect(
          (await server.get(`/api/v1/routes?${query}`)).status,
          query,
        ).toBe(400);
      }
    });
  });

  describe("route insights (P9-02)", () => {
    it("serves the histogram of one route from the rollups", async () => {
      const h = await server.json<RouteHistogramResponse>(
        "/api/v1/routes/histogram?route=/orders/:id&method=GET",
      );
      expect(h).toMatchObject({
        method: "GET",
        route: "/orders/:id",
        count: 2,
      });
      expect(h.buckets).toHaveLength(30);
      expect(h.buckets[0]).toMatchObject({ fromMs: 0, toMs: 1 });
      expect(h.buckets.at(-1)?.toMs).toBeNull();
      expect(h.buckets.reduce((n, b) => n + b.count, 0)).toBe(2);
      expect(h.p50Ms).toBeGreaterThan(0);
      expect(h.p99Ms).toBeGreaterThanOrEqual(h.p95Ms);
      expect(h.p99Ms).toBeLessThanOrEqual(h.maxMs);
      const none = await server.json<RouteHistogramResponse>(
        "/api/v1/routes/histogram?route=/orders/:id&service=worker",
      );
      expect(none.count).toBe(0);
      expect(
        (await server.get("/api/v1/routes/histogram?method=GET")).status,
      ).toBe(400);
    });

    it("compares the window with the previous one", async () => {
      const c = await server.json<RouteCompareResponse>(
        "/api/v1/routes/compare?windowMinutes=15",
      );
      if (c.mode !== "window") throw new Error("expected window mode");
      expect(c.current.fromUnixMs - c.previous.fromUnixMs).toBe(15 * 60_000);
      // The data is minutes old, so nothing was counted before it.
      expect(c.previousCovered).toBe(false);
      expect(c.note).toMatch(/previous window/);
      expect(c.releases).toEqual(expect.arrayContaining(["1.2.0", "1.1.0"]));
      const orders = c.routes.find((r) => r.route === "/orders/:id");
      expect(orders?.after).toMatchObject({ count: 2, errors: 1 });
      expect(orders?.before.count).toBe(0);
      expect(orders?.delta).toMatchObject({ count: 2, p95Ms: null });
    });

    it("compares two releases from the stored traces", async () => {
      const c = await server.json<RouteCompareResponse>(
        "/api/v1/routes/compare?releaseA=1.1.0&releaseB=1.2.0",
      );
      if (c.mode !== "release") throw new Error("expected release mode");
      const orders = c.routes.find((r) => r.route === "/orders/:id");
      expect(orders?.method).toBe("GET");
      expect(orders?.before.count).toBe(0);
      expect(orders?.after).toMatchObject({ count: 2, errors: 1 });
      expect(orders?.after.p95Ms).toBeGreaterThan(0);
      expect(orders?.delta.errorRate).toBeCloseTo(0.5);
      const post = c.routes.find((r) => r.route === "/orders");
      expect(post?.before.count).toBe(1);
      expect(post?.after.count).toBe(0);
      const other = await server.json<RouteCompareResponse>(
        "/api/v1/routes/compare?releaseA=1.1.0&releaseB=1.2.0&service=worker",
      );
      expect(other.routes).toEqual([]);
      expect(
        (await server.get("/api/v1/routes/compare?releaseA=1.1.0")).status,
      ).toBe(400);
    });

    it("limits the trace list by maxDurationMs", async () => {
      const ids = async (q: string) =>
        (await server.json<TraceListResponse>(`/api/v1/traces?${q}`)).items.map(
          (i) => i.traceId,
        );
      expect(await ids("minDurationMs=500")).toContain(E);
      expect(await ids("maxDurationMs=500")).not.toContain(E);
      expect(await ids("minDurationMs=500&maxDurationMs=1000")).toEqual([E]);
      expect((await server.get("/api/v1/traces?maxDurationMs=-1")).status).toBe(
        400,
      );
    });
  });

  describe("classes", () => {
    it("sums method spans, with own time from the stored spans", async () => {
      const r = await server.json<ClassStatsResponse>("/api/v1/classes");
      expect(r.methodsEnabled).toBe(true);
      expect(r.methodsState).toBe("on");
      expect(r.windowMinutes).toBe(15);
      expect(r.classes).toHaveLength(1);
      const c = r.classes[0];
      expect(c).toMatchObject({
        className: "OrdersService",
        kind: "service",
        calls: 1,
        errors: 0,
      });
      expect(c?.totalMs).toBeCloseTo(80, 3);
      expect(c?.avgMs).toBeCloseTo(80, 3);
      expect(c?.methods).toHaveLength(1);
      expect(c?.methods[0]).toMatchObject({
        method: "find",
        calls: 1,
        errors: 0,
        maxMs: 80,
      });
      // 80 ms minus its children: 60 ms (the call to payments) and 10 ms (the query).
      expect(c?.methods[0]?.ownAvgMs).toBeCloseTo(10, 3);
      expect(c?.ownMs).toBeCloseTo(10, 3);
    });

    it("filters by service", async () => {
      const shop = await server.json<ClassStatsResponse>(
        "/api/v1/classes?service=shop",
      );
      expect(shop.classes.map((c) => c.className)).toEqual(["OrdersService"]);
      const payments = await server.json<ClassStatsResponse>(
        "/api/v1/classes?service=payments",
      );
      expect(payments.classes).toEqual([]);
      expect(payments.methodsEnabled).toBe(false);
      expect(payments.methodsState).toBe("off");
      expect(
        (
          await server.json<ClassStatsResponse>(
            "/api/v1/classes?windowMinutes=60",
          )
        ).windowMinutes,
      ).toBe(60);
      expect((await server.get("/api/v1/classes?windowMinutes=5")).status).toBe(
        400,
      );
    });
  });

  describe("classes: methodsState", () => {
    it("separates never-seen (off) from idle past the window (no-data-in-range) and in-window (on)", async () => {
      // An older minute; make sure its day has a partition (it may be yesterday just after midnight UTC).
      const old = new Date(
        Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000,
      );
      await ensurePartitions(db.pool, [utcDay(old.getTime())]);
      await db.pool.query(
        `INSERT INTO class_minutes
           (minute, service_name, class_name, method_name, class_kind, count, errors, total_ms, max_ms, hist)
         VALUES ($1, 'idle-worker', 'MailService', 'send', 'service', 3, 0, 30, 15, '{}')`,
        [old],
      );
      const get = (q: string) =>
        server.json<ClassStatsResponse>(`/api/v1/classes${q}`);

      // No class_minutes rows for this service at all, while others have data: off.
      const never = await get("?service=payments");
      expect([never.methodsState, never.methodsEnabled]).toEqual([
        "off",
        false,
      ]);

      // Rows exist, all older than the 15-minute window: not off.
      const idle = await get("?service=idle-worker");
      expect(idle.classes).toEqual([]);
      expect([idle.methodsState, idle.methodsEnabled]).toEqual([
        "no-data-in-range",
        true,
      ]);

      // The wider window reaches them.
      const wide = await get("?service=idle-worker&windowMinutes=60");
      expect(wide.methodsState).toBe("on");
      expect(wide.classes.map((c) => c.className)).toEqual(["MailService"]);

      // Rows in the window: on, with and without the service filter.
      expect((await get("?service=shop")).methodsState).toBe("on");
      expect((await get("")).methodsState).toBe("on");
    });
  });

  describe("map", () => {
    const byId = (m: AppMapResponse) => new Map(m.nodes.map((n) => [n.id, n]));
    const edge = (m: AppMapResponse, from: string, to: string) =>
      m.edges.find((e) => e.from === from && e.to === to);

    it("draws every service, its external targets and the calls between services", async () => {
      const m = await server.json<AppMapResponse>("/api/v1/map");
      expect(m.windowMinutes).toBe(15);
      const nodes = byId(m);
      expect([...nodes.keys()].sort()).toEqual(
        [
          "service:payments",
          "service:shop",
          "service:worker",
          "db:postgresql:db:5432/shop",
          "db:postgresql:db:5432/pay",
          "http:api.stripe.com",
        ].sort(),
      );
      expect(nodes.get("service:shop")).toEqual({
        id: "service:shop",
        kind: "app",
        name: "shop",
      });
      expect(nodes.get("db:postgresql:db:5432/shop")).toEqual({
        id: "db:postgresql:db:5432/shop",
        kind: "database",
        name: "postgresql shop",
        system: "postgresql",
      });
      expect(nodes.get("http:api.stripe.com")).toMatchObject({
        kind: "http",
        name: "api.stripe.com",
      });
      // The call to payments is an edge between services, not an external http target.
      expect(nodes.has("http:payments:4000")).toBe(false);
      expect(m.edges).toHaveLength(4);
      const cross = edge(m, "service:shop", "service:payments");
      expect(cross).toMatchObject({ calls: 1, errors: 0 });
      expect(cross?.p50Ms).toBeGreaterThan(30);
      expect(cross?.p95Ms).toBeLessThanOrEqual(60);
      expect(
        edge(m, "service:shop", "db:postgresql:db:5432/shop"),
      ).toMatchObject({ calls: 1 });
      expect(
        edge(m, "service:payments", "db:postgresql:db:5432/pay"),
      ).toMatchObject({ calls: 1 });
      expect(edge(m, "service:shop", "http:api.stripe.com")).toMatchObject({
        calls: 1,
        errors: 0,
      });
      expect(edge(m, "service:worker", "service:shop")).toBeUndefined();
    });

    it("filters to one service and the services it talks to", async () => {
      const shop = await server.json<AppMapResponse>(
        "/api/v1/map?service=shop",
      );
      expect([...byId(shop).keys()].sort()).toEqual(
        [
          "service:shop",
          "service:payments",
          "db:postgresql:db:5432/shop",
          "http:api.stripe.com",
        ].sort(),
      );
      expect(shop.edges).toHaveLength(3);
      expect(
        edge(shop, "service:payments", "db:postgresql:db:5432/pay"),
      ).toBeUndefined();

      // The callee's view includes its caller.
      const payments = await server.json<AppMapResponse>(
        "/api/v1/map?service=payments",
      );
      expect([...byId(payments).keys()].sort()).toEqual(
        [
          "service:payments",
          "service:shop",
          "db:postgresql:db:5432/pay",
        ].sort(),
      );
      expect(edge(payments, "service:shop", "service:payments")).toBeDefined();

      const worker = await server.json<AppMapResponse>(
        "/api/v1/map?service=worker",
      );
      expect(worker.nodes.map((n) => n.id)).toEqual(["service:worker"]);
      expect(worker.edges).toEqual([]);

      const unknown = await server.json<AppMapResponse>(
        "/api/v1/map?service=nope",
      );
      expect(unknown.nodes).toEqual([]);
      expect(unknown.edges).toEqual([]);
    });

    it("rejects bad parameters", async () => {
      for (const query of ["windowMinutes=0", "windowMinutes=30", "x=1"]) {
        expect((await server.get(`/api/v1/map?${query}`)).status, query).toBe(
          400,
        );
      }
    });
  });

  describe("headers", () => {
    it("never emits CORS headers, and never caches", async () => {
      for (const path of [
        "/api/v1/meta",
        "/api/v1/traces",
        "/api/v1/traces?limit=0",
        `/api/v1/trace?id=${tid(999)}`,
      ]) {
        const res = await server.get(path, { origin: "https://evil.example" });
        for (const name of res.headers.keys()) {
          expect(
            name.toLowerCase().startsWith("access-control-"),
            `${path}: ${name}`,
          ).toBe(false);
        }
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("content-type")).toContain("application/json");
      }
      const preflight = await fetch(`${server.baseUrl}/api/v1/traces`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("end to end through the HTTP receiver", () => {
    it("shows a span posted as OTLP/JSON", async () => {
      const traceId = tid(7777);
      const start = BigInt(Date.now() - 5000) * 1_000_000n;
      const body = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "http-svc" } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "t" },
                spans: [
                  {
                    traceId,
                    spanId: sid(777),
                    name: "GET /ping",
                    kind: 2,
                    startTimeUnixNano: String(start),
                    endTimeUnixNano: String(start + 3_000_000n),
                    attributes: [
                      {
                        key: "http.request.method",
                        value: { stringValue: "GET" },
                      },
                      { key: "http.route", value: { stringValue: "/ping" } },
                      {
                        key: "http.response.status_code",
                        value: { intValue: "200" },
                      },
                    ],
                    status: {},
                  },
                ],
              },
            ],
          },
        ],
      });
      const res = await post(`${server.baseUrl}/v1/traces`, body, {
        ...auth(KEY),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(200);
      const list = await server.json<TraceListResponse>(
        "/api/v1/traces?service=http-svc",
      );
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        traceId,
        name: "GET /ping",
        route: "/ping",
        statusCode: 200,
      });
      const routes = await server.json<RouteStatsResponse>(
        "/api/v1/routes?service=http-svc",
      );
      expect(routes.routes.map((r) => r.route)).toEqual(["/ping"]);
    });
  });
});

describe.skipIf(noDatabase)(`query API access ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  beforeAll(async () => {
    db = await createTestDb("queryguard");
    // The default deny guard instead of the session guard: closed even for a signed-in admin.
    server = await startQueryServer(db.url, false);
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("answers 401 signed out and 200 signed in through the real session guard", async () => {
    const real = await startQueryServer(db.url, true, false);
    try {
      const anonymous = await real.get("/api/v1/meta");
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
      const signedIn = await fetch(`${real.baseUrl}/api/v1/meta`, {
        headers: {
          cookie: signedCookie(
            undefined,
            undefined,
            undefined,
            Number(new URL(real.baseUrl).port),
          ),
        },
      });
      expect(signedIn.status).toBe(200);
    } finally {
      await real.close();
    }
  });

  it("is closed until a guard opens it", async () => {
    for (const path of [
      "/api/v1/meta",
      "/api/v1/traces",
      "/api/v1/traces?limit=0",
      "/api/v1/map",
    ]) {
      const res = await server.get(path);
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
