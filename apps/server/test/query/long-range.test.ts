/**
 * Issue #29 (D-107): the aggregate routes over ranges beyond 60 minutes, against PostgreSQL.
 */
import "reflect-metadata";
import type {
  ErrorGroupsResponse,
  OverviewResponse,
  RouteStatsResponse,
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
const HOUR = 60 * MIN;
const NOW = Date.now();

const root = (n: number, startMs: number, error = false) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: "GET /orders",
    kind: "server",
    startMs,
    durationMs: 100 + n,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": error ? 500 : 200,
    },
    ...(error ? { status: { code: "error" as const, message: "boom" } } : {}),
  });

describe.skipIf(noDatabase)(`long ranges ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("longrange");
    server = await startQueryServer(db.url);
    await server.app
      .get(PostgresIngestSink)
      .write(
        batch("shop", [
          root(1, NOW - 30 * HOUR),
          root(2, NOW - 20 * HOUR, true),
          root(3, NOW - 20 * HOUR + MIN),
          root(4, NOW - 3 * HOUR),
          root(5, NOW - 2 * MIN),
        ]),
      );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("routes: 24 hours leaves out the request 30 hours ago, 7 days has it", async () => {
    const day = await server.json<RouteStatsResponse>(
      "/api/v1/routes?windowMinutes=1440",
    );
    expect(day.windowMinutes).toBe(1440);
    expect(day.bucketMs).toBe(HOUR);
    expect(day.routes[0]).toMatchObject({ count: 4, errors: 1 });
    expect(day.routes[0]?.series).toHaveLength(24);
    expect(day.routes[0]?.series.reduce((n, p) => n + p.count, 0)).toBe(4);
    const week = await server.json<RouteStatsResponse>(
      "/api/v1/routes?windowMinutes=10080",
    );
    expect(week.routes[0]).toMatchObject({ count: 5, errors: 1 });
    expect(week.routes[0]?.series).toHaveLength(168);
  });

  it("routes: a range reads what it covers and says what was read", async () => {
    const from = NOW - 21 * HOUR;
    const to = NOW - 19 * HOUR;
    const r = await server.json<RouteStatsResponse>(
      `/api/v1/routes?fromUnixMs=${from}&toUnixMs=${to}`,
    );
    expect(r.routes[0]).toMatchObject({ count: 2, errors: 1 });
    expect(r.fromUnixMs).toBeLessThanOrEqual(from);
    expect(r.toUnixMs).toBe(to);
  });

  it("error groups and the overview answer for 24 hours", async () => {
    const g = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?windowMinutes=1440",
    );
    expect(g.windowMinutes).toBe(1440);
    expect(g.bucketMs).toBe(HOUR);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]?.count).toBe(1);
    const o = await server.json<OverviewResponse>(
      "/api/v1/overview?windowMinutes=1440",
    );
    expect(o.windowMinutes).toBe(1440);
    expect(o.totals.count).toBe(4);
  });

  it("answers 400 to a window past the retention, to both forms together and to half a range", async () => {
    for (const q of [
      "windowMinutes=43200",
      `windowMinutes=60&fromUnixMs=${NOW - HOUR}&toUnixMs=${NOW}`,
      `fromUnixMs=${NOW - HOUR}`,
      `fromUnixMs=${NOW - 8 * 24 * HOUR}&toUnixMs=${NOW}`,
    ]) {
      expect((await server.get(`/api/v1/routes?${q}`)).status, q).toBe(400);
    }
  });
});

// Issue #29 merged with #28 (D-101, D-107): the summed rollups and the long-range span views keep
// environments apart.
describe.skipIf(noDatabase)(`long ranges per environment ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("longrange_env");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("shop", [root(11, NOW - 30 * HOUR), root(12, NOW - 20 * HOUR)], {
        "deployment.environment.name": "production",
      }),
    );
    await sink.write(
      batch(
        "shop",
        [
          root(21, NOW - 50 * HOUR),
          root(22, NOW - 10 * HOUR, true),
          root(23, NOW - 5 * HOUR, true),
        ],
        { "deployment.environment.name": "staging" },
      ),
    );
    await sink.write(batch("shop", [root(31, NOW - 4 * HOUR)]));
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const routeTotals = async (query: string) => {
    const r = await server.json<RouteStatsResponse>(`/api/v1/routes?${query}`);
    return {
      count: r.routes.reduce((n, x) => n + x.count, 0),
      errors: r.routes.reduce((n, x) => n + x.errors, 0),
    };
  };

  it("routes over 7 days and 24 hours count each environment alone", async () => {
    expect(await routeTotals("windowMinutes=10080")).toEqual({
      count: 6,
      errors: 2,
    });
    expect(
      await routeTotals("windowMinutes=10080&environment=production"),
    ).toEqual({ count: 2, errors: 0 });
    expect(
      await routeTotals("windowMinutes=10080&environment=staging"),
    ).toEqual({ count: 3, errors: 2 });
    expect(await routeTotals("windowMinutes=10080&environment=unset")).toEqual({
      count: 1,
      errors: 0,
    });
    expect(await routeTotals("windowMinutes=1440&environment=staging")).toEqual(
      { count: 2, errors: 2 },
    );
    expect(
      await routeTotals(
        `fromUnixMs=${NOW - 26 * HOUR}&toUnixMs=${NOW}&environment=production`,
      ),
    ).toEqual({ count: 1, errors: 0 });
  });

  it("the overview, the histogram and the window comparison over 24 hours are scoped", async () => {
    const o = await server.json<OverviewResponse>(
      "/api/v1/overview?windowMinutes=1440&environment=staging",
    );
    expect(o.totals.count).toBe(2);
    const prod = await server.json<OverviewResponse>(
      "/api/v1/overview?windowMinutes=1440&environment=production",
    );
    expect(prod.totals.count).toBe(1);
    const h = await server.json<{ count: number }>(
      "/api/v1/routes/histogram?route=/orders&method=GET&windowMinutes=1440&environment=unset",
    );
    expect(h.count).toBe(1);
    const c = await server.json<{
      routes: {
        before: { count: number } | null;
        after: { count: number } | null;
      }[];
    }>("/api/v1/routes/compare?windowMinutes=1440&environment=production");
    const sum = (side: "before" | "after") =>
      c.routes.reduce((n, r) => n + (r[side]?.count ?? 0), 0);
    expect(sum("after")).toBe(1);
    expect(sum("before")).toBe(1);
  });

  it("error groups over 24 hours are per environment", async () => {
    const staging = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?windowMinutes=1440&environment=staging",
    );
    expect(staging.groups[0]?.count).toBe(2);
    const prod = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?windowMinutes=1440&environment=production",
    );
    expect(prod.groups).toHaveLength(0);
  });
});
