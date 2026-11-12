/**
 * `GET /api/v1/queries` (P9-03). The SQL builder is unit-tested without a database; the
 * endpoint test runs against PostgreSQL and is skipped, like the other query tests, without one.
 */
import "reflect-metadata";
import type { QueryStatsResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queriesSql } from "../../src/query/queries-sql.js";
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

describe("queriesSql", () => {
  const base = {
    from: new Date(0),
    to: new Date(1),
    service: undefined,
    limit: 25,
  };

  it("binds values as parameters and orders by the whitelisted column", () => {
    const a = queriesSql({ ...base, sort: "p95" });
    expect(a.values).toEqual([new Date(0), new Date(1), 25]);
    expect(a.text).toContain("ORDER BY agg.p95_ns DESC");
    expect(a.text).toContain("LIMIT $3");
    expect(a.text).toContain("s.start_time >= $1");
    expect(a.text).not.toContain("service_name");
    for (const [sort, column] of [
      ["total", "total_ns"],
      ["count", "n"],
      ["max", "max_ns"],
    ] as const) {
      expect(queriesSql({ ...base, sort }).text).toContain(
        `ORDER BY agg.${column} DESC`,
      );
    }
  });

  it("adds the service filter as a parameter, never in the text", () => {
    const q = queriesSql({
      ...base,
      sort: "total",
      service: "x'; DROP TABLE spans; --",
    });
    expect(q.values[2]).toBe("x'; DROP TABLE spans; --");
    expect(q.text).toContain("s.service_name = $3");
    expect(q.text).toContain("LIMIT $4");
    expect(q.text).not.toContain("DROP");
  });
});

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
const T0 = Date.now() - 90_000;
const SEL = "SELECT * FROM users WHERE id = ?";

const db1 = (traceId: string, n: number, ms: number, sql = SEL) =>
  span({
    traceId,
    spanId: sid(n),
    name: "SELECT",
    kind: "client",
    startMs: T0 + n,
    durationMs: ms,
    attributes: { "db.system.name": "postgresql", "db.query.text": sql },
    ...(ms === 99 ? { status: { code: "error" as const } } : {}),
  });

describe.skipIf(noDatabase)(`queries endpoint ${skipReason}`, () => {
  let testDb: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    testDb = await createTestDb("queries");
    server = await startQueryServer(testDb.url);
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("shop", [
        db1(tid(1), 1, 10),
        db1(tid(2), 2, 30),
        db1(tid(2), 3, 20),
        db1(tid(2), 4, 99),
        db1(tid(3), 5, 1, "SELECT 2"),
        span({
          traceId: tid(3),
          spanId: sid(6),
          kind: "client",
          startMs: T0,
          durationMs: 1,
        }),
      ]),
    );
  });
  afterAll(async () => {
    await server?.close();
    await testDb?.drop();
  });

  it("aggregates per statement with N+1 counts and example traces", async () => {
    const r = await server.json<QueryStatsResponse>("/api/v1/queries");
    expect(r.sampled).toBe(true);
    expect(r.queries.map((q) => q.statement)).toEqual([SEL, "SELECT 2"]);
    expect(r.queries[0]).toMatchObject({
      system: "postgresql",
      kind: "database",
      count: 4,
      errors: 1,
      traces: 2,
      repeatedTraces: 1,
      maxMs: 99,
    });
    expect(r.queries[0]?.exampleTraceIds).toEqual([tid(2), tid(1)]);
    const byCount = await server.json<QueryStatsResponse>(
      "/api/v1/queries?sort=count&limit=1",
    );
    expect(byCount.queries).toHaveLength(1);
  });

  it("answers 400 on a bad sort", async () => {
    expect((await server.get("/api/v1/queries?sort=nope")).status).toBe(400);
  });
});
