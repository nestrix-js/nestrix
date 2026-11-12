/**
 * P15-01: `GET /api/v1/classes`, `/dependencies` and `/map` carry the previous window (the same
 * length, just before the current one) as optional fields, against PostgreSQL.
 */
import "reflect-metadata";
import type {
  AppMapResponse,
  ClassStatsResponse,
  DependenciesResponse,
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
const METHOD = {
  "nestrix.class": "OrdersService",
  "nestrix.method": "place",
  "nestrix.component": "service",
};

/** A minute-aligned instant `minutesAgo` minutes ago, 10 s into the minute. */
const at = (minutesAgo: number) =>
  Math.floor((NOW - minutesAgo * MIN) / MIN) * MIN + 10_000;

const root = (n: number, startMs: number) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: "GET /x",
    kind: "server",
    startMs,
    durationMs: 500,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/x",
      "http.response.status_code": 200,
    },
  });

/** A trace: a root, a method span under it and a database call under the method. */
function trace(
  n: number,
  startMs: number,
  methodMs: number,
  dbMs: number,
  error = false,
) {
  return [
    root(n, startMs),
    span({
      traceId: tid(n),
      spanId: sid(n + 1000),
      parentSpanId: sid(n),
      name: "OrdersService.place",
      startMs: startMs + 1,
      durationMs: methodMs,
      attributes: METHOD,
      ...(error ? { status: { code: "error" as const } } : {}),
    }),
    span({
      traceId: tid(n),
      spanId: sid(n + 2000),
      parentSpanId: sid(n + 1000),
      name: "pg.query",
      kind: "client",
      startMs: startMs + 2,
      durationMs: dbMs,
      attributes: PG,
      ...(error ? { status: { code: "error" as const } } : {}),
    }),
  ];
}

describe.skipIf(noDatabase)(`previous window ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let young: TestDb;
  let youngServer: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("prevwin");
    server = await startQueryServer(db.url);
    await server.app.get(PostgresIngestSink).write(
      batch("shop", [
        // Previous 15 minute window (30 to 15 minutes ago): two calls, one failing.
        ...trace(1, at(20), 100, 40),
        ...trace(2, at(19), 300, 80, true),
        // Current window: one call.
        ...trace(3, at(2), 50, 10),
        // The statistics reach back 40 minutes.
        root(4, at(40)),
      ]),
    );
    // A server whose data starts two minutes ago: no previous window.
    young = await createTestDb("prevwin_young");
    youngServer = await startQueryServer(young.url);
    await youngServer.app
      .get(PostgresIngestSink)
      .write(batch("shop", [...trace(5, at(2), 50, 10)]));
  });
  afterAll(async () => {
    await server?.close();
    await youngServer?.close();
    await db?.drop();
    await young?.drop();
  });

  it("classes: previous per class and in the totals, with its own own-time", async () => {
    const r = await server.json<ClassStatsResponse>("/api/v1/classes");
    expect(r.previousCovered).toBe(true);
    expect(r.note).toBeNull();
    expect(r.classes).toHaveLength(1);
    const c = r.classes[0];
    expect(c).toMatchObject({
      className: "OrdersService",
      calls: 1,
      previous: { calls: 2, errors: 1 },
    });
    expect(c?.previous?.totalMs).toBeCloseTo(400, 0);
    // Own time per call: 100 - 40 and 300 - 80, averaged over the previous window only, times 2.
    expect(c?.previous?.ownMs).toBeCloseTo(280, 0);
    // The current window's own time is its own: 50 - 10 for one call.
    expect(c?.ownMs).toBeCloseTo(40, 0);
    expect(r.previousTotals).toMatchObject({ classes: 1, calls: 2, errors: 1 });
    expect(
      (await server.json<ClassStatsResponse>("/api/v1/classes?service=nobody"))
        .classes,
    ).toEqual([]);
  });

  it("dependencies: previous per target and in the totals", async () => {
    const r = await server.json<DependenciesResponse>("/api/v1/dependencies");
    expect(r.previousCovered).toBe(true);
    expect(r.dependencies).toHaveLength(1);
    expect(r.dependencies[0]).toMatchObject({
      calls: 1,
      errors: 0,
      previous: { calls: 2, errors: 1, errorRate: 0.5 },
    });
    expect(r.dependencies[0]?.previous?.totalMs).toBeCloseTo(120, 0);
    expect(r.previousTotals).toMatchObject({
      dependencies: 1,
      calls: 2,
      errors: 1,
    });
    expect(r.previousTotals?.slowestP95Ms).toBeGreaterThan(0);
  });

  it("map: previous per edge and in the totals", async () => {
    const r = await server.json<AppMapResponse>("/api/v1/map");
    expect(r.previousCovered).toBe(true);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toMatchObject({
      calls: 1,
      previous: { calls: 2, errors: 1 },
    });
    expect(r.previousTotals).toMatchObject({ targets: 1, calls: 2, errors: 1 });
  });

  it("a window with no covered previous window says why and adds nothing", async () => {
    for (const path of ["classes", "dependencies", "map"]) {
      const r = await youngServer.json<Record<string, unknown>>(
        `/api/v1/${path}`,
      );
      expect(r.previousCovered).toBe(false);
      expect(r.note).toMatch(/less than two windows/);
      expect(r.previousTotals).toBeUndefined();
    }
    const deps = await youngServer.json<DependenciesResponse>(
      "/api/v1/dependencies",
    );
    expect(deps.dependencies[0]?.calls).toBe(1);
    expect(deps.dependencies[0]?.previous).toBeUndefined();
    // A 60 minute window needs two hours of statistics: the first server has 40 minutes.
    const hour = await server.json<DependenciesResponse>(
      "/api/v1/dependencies?windowMinutes=60",
    );
    expect(hour.previousCovered).toBe(false);
  });
});
