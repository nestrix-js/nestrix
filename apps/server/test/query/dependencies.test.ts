/**
 * P9-05: `GET /api/v1/dependencies`, `GET /api/v1/traces/timeline` and the trace list's time range.
 */
import "reflect-metadata";
import type {
  DependenciesResponse,
  TraceListResponse,
  TraceTimelineResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const sid = (n: number) => n.toString(16).padStart(16, "0");
const MIN = 60_000;
const NOW = Date.now();
const PG = {
  "db.system.name": "postgresql",
  "server.address": "db.local",
  "db.namespace": "shop",
};

const root = (n: number, startMs: number, status: number, error = false) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: "GET /x",
    kind: "server",
    startMs,
    durationMs: 50,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/x",
      "http.response.status_code": status,
    },
    ...(error ? { status: { code: "error" as const } } : {}),
  });

const query = (n: number, parent: number, startMs: number, ms: number) =>
  span({
    traceId: tid(parent),
    spanId: sid(n),
    parentSpanId: sid(parent),
    name: "pg.query",
    kind: "client",
    startMs,
    durationMs: ms,
    attributes: PG,
  });

describe.skipIf(noDatabase)(`dependencies and timeline ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  // Inside one bucket each, whatever the second the test starts at.
  const t1 = Math.floor((NOW - 3 * MIN) / MIN) * MIN + 10_000;
  const t2 = Math.floor((NOW - MIN) / MIN) * MIN + 10_000;

  beforeAll(async () => {
    db = await createTestDb("deps");
    server = await startQueryServer(db.url);
    await server.app
      .get(PostgresIngestSink)
      .write(
        batch("shop", [
          root(1, t1, 200),
          query(101, 1, t1 + 1, 100),
          query(102, 1, t1 + 2, 300),
          root(2, t1 + 5, 404),
          root(3, t2, 503),
          root(4, t2 + 5, 200, true),
          root(5, t2 + 6, 200),
          query(103, 5, t2 + 7, 200),
          root(6, NOW - 40 * MIN, 200),
        ]),
      );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("lists targets with totals, quantiles, an example trace and a bucketed series", async () => {
    const r = await server.json<DependenciesResponse>("/api/v1/dependencies");
    expect(r.bucketMs).toBe(MIN);
    expect(r.dependencies).toHaveLength(1);
    const d = r.dependencies[0];
    expect(d).toMatchObject({
      id: "db:postgresql:db.local/shop",
      kind: "database",
      calls: 3,
      errors: 0,
      exampleTraceId: tid(1),
    });
    expect(d?.totalMs).toBeCloseTo(600, 0);
    expect(d?.series).toHaveLength(15);
    expect(d?.series.reduce((n, p) => n + p.calls, 0)).toBe(3);
    expect(d?.series.filter((p) => p.calls > 0).map((p) => p.calls)).toEqual([
      2, 1,
    ]);
    const wide = await server.json<DependenciesResponse>(
      "/api/v1/dependencies?windowMinutes=60&service=shop",
    );
    expect(wide.bucketMs).toBe(5 * MIN);
    expect(wide.dependencies[0]?.series).toHaveLength(12);
    const other = await server.json<DependenciesResponse>(
      "/api/v1/dependencies?service=nobody",
    );
    expect(other.dependencies).toEqual([]);
  });

  it("counts traces per bucket by outcome and applies the list filters", async () => {
    const r = await server.json<TraceTimelineResponse>(
      "/api/v1/traces/timeline",
    );
    expect(r.buckets).toHaveLength(15);
    const traffic = r.buckets.filter(
      (b) => b.ok + b.clientError + b.serverError > 0,
    );
    expect(traffic.map((b) => [b.ok, b.clientError, b.serverError])).toEqual([
      [1, 1, 0],
      [1, 0, 2],
    ]);
    const only = await server.json<TraceTimelineResponse>(
      "/api/v1/traces/timeline?status=5xx",
    );
    expect(only.buckets.reduce((n, b) => n + b.serverError, 0)).toBe(1);
    expect(only.buckets.reduce((n, b) => n + b.ok, 0)).toBe(0);
    const hour = await server.json<TraceTimelineResponse>(
      "/api/v1/traces/timeline?windowMinutes=60",
    );
    expect(hour.buckets).toHaveLength(12);
    expect(hour.buckets.reduce((n, b) => n + b.ok, 0)).toBe(3);
  });

  it("filters the trace list by time range", async () => {
    const r = await server.json<TraceListResponse>(
      `/api/v1/traces?fromUnixMs=${t1 - 1000}&toUnixMs=${t1 + 2}`,
    );
    expect(r.items.map((i) => i.traceId)).toEqual([tid(1)]);
    expect((await server.get("/api/v1/traces?fromUnixMs=x")).status).toBe(400);
    expect(
      (await server.get("/api/v1/dependencies?windowMinutes=5")).status,
    ).toBe(400);
  });
});
