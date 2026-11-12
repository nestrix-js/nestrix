/**
 * P11-01: `GET /api/v1/overview` on the standalone server. The computation itself is tested in
 * `packages/nestjs/test/overview-compute-unit.test.ts`; `overview-compute.ts` here must stay a
 * byte-identical copy of that module (the first test). The route tests run against PostgreSQL.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OverviewResponse } from "@nestrix-js/protocol";
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

describe("overview-compute.ts", () => {
  it("is a byte-identical copy of the embedded dashboard's module", () => {
    const here = (p: string) =>
      readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    expect(here("../../src/query/overview-compute.ts")).toBe(
      here("../../../../packages/nestjs/src/overview/compute.ts"),
    );
  });
});

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
const MIN = 60_000;
const NOW = Date.now();
const PG = { "db.system.name": "postgresql", "server.address": "db.local" };

const root = (
  n: number,
  startMs: number,
  durationMs: number,
  status = 200,
  error = false,
) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: "GET /orders",
    kind: "server",
    startMs,
    durationMs,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": status,
    },
    ...(error ? { status: { code: "error" as const, message: "boom" } } : {}),
  });

describe.skipIf(noDatabase)(`overview endpoint ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("overview");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    const prev = Math.floor((NOW - 20 * MIN) / MIN) * MIN;
    const cur = Math.floor((NOW - 8 * MIN) / MIN) * MIN;
    // An old request of release 1.0 makes the statistics cover the previous window; release 2.0
    // is first seen inside the current one.
    // Previous window: 25 fast requests. Current window: 25 slow ones, 6 of them failing.
    const old: ReturnType<typeof root>[] = [root(1, NOW - 40 * MIN, 50)];
    for (let i = 0; i < 25; i++) old.push(root(100 + i, prev + i * 1000, 50));
    await sink.write(batch("shop", old, { "service.version": "1.0" }));
    const shop: ReturnType<typeof root>[] = [];
    for (let i = 0; i < 25; i++) {
      shop.push(root(200 + i, cur + i * 1000, 700, i < 6 ? 500 : 200, i < 6));
    }
    // A database call of 100 ms inside five of the slow requests.
    for (let i = 0; i < 5; i++) {
      shop.push(
        span({
          traceId: tid(200 + i),
          spanId: sid(900 + i),
          parentSpanId: sid(200 + i),
          name: "pg.query",
          kind: "client",
          startMs: cur + i * 1000 + 1,
          durationMs: 100,
          attributes: PG,
        }),
      );
    }
    await sink.write(batch("shop", shop, { "service.version": "2.0" }));
    await sink.write(
      batch("billing", [root(300, cur, 20), root(301, cur + 1000, 20)]),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("answers the shape of the contract, with the slowdown under needs attention", async () => {
    const r = await server.json<OverviewResponse>(
      "/api/v1/overview?service=shop",
    );
    expect(r.windowMinutes).toBe(15);
    expect(r.bucketMs).toBe(MIN);
    expect(r.apdexMs).toBe(300);
    expect(r.previousCovered).toBe(true);
    expect(r.note).toBeNull();
    expect(r.totals.count).toBe(25);
    expect(r.totals.errors).toBe(6);
    expect(r.previousTotals?.count).toBe(25);
    expect(r.series).toHaveLength(15);
    expect(r.previousSeries).toHaveLength(15);
    expect(r.series.reduce((n, p) => n + p.count, 0)).toBe(25);
    expect(r.totals.apdex).not.toBeNull();
    expect(r.health.score).toBeGreaterThanOrEqual(0);
    expect(r.health.score).toBeLessThanOrEqual(100);
    expect(["healthy", "degraded", "critical"]).toContain(r.health.level);

    const kinds = r.attention.map((i) => i.kind);
    expect(kinds).toContain("route-latency");
    expect(kinds).toContain("route-errors");
    const latency = r.attention.find((i) => i.kind === "route-latency");
    expect(latency?.title).toMatch(/^GET \/orders p95 \d+ ms → \d+ ms$/);
    expect(latency?.link).toEqual({
      view: "route",
      params: { route: "/orders", method: "GET" },
    });
    expect(r.health.summary).toMatch(/need attention: /);

    // Sampled traces of the window: 19 ok, 6 failed; one new release; time in the database.
    expect(r.status).toEqual({
      ok: 19,
      redirect: 0,
      clientError: 0,
      serverError: 6,
    });
    expect(r.releases.map((x) => x.version)).toEqual(["2.0"]);
    const db = r.timeByKind.find((k) => k.key === "db");
    expect(db?.ms).toBeCloseTo(500, 0);
    expect(r.timeByKind).toHaveLength(6);
    expect(r.timeByKind.reduce((n, k) => n + k.share, 0)).toBeCloseTo(1);
  });

  it("lists a burning SLO under needs attention, for its own service only", async () => {
    await db.pool.query(
      `INSERT INTO slos (name, service_name, kind, objective, window_days)
       VALUES ('orders availability', 'shop', 'availability', 0.999, 7)`,
    );
    const shop = await server.json<OverviewResponse>(
      "/api/v1/overview?service=shop",
    );
    const burn = shop.attention.find((i) => i.kind === "slo-burn");
    expect(burn?.severity).toBe("high");
    expect(burn?.title).toContain("orders availability");
    expect(burn?.link.view).toBe("slos");
    const billing = await server.json<OverviewResponse>(
      "/api/v1/overview?service=billing",
    );
    expect(billing.attention.some((i) => i.kind === "slo-burn")).toBe(false);
  });

  it("honours the service filter, the window and the Apdex target", async () => {
    const all = await server.json<OverviewResponse>("/api/v1/overview");
    expect(all.totals.count).toBe(27);
    const billing = await server.json<OverviewResponse>(
      "/api/v1/overview?service=billing",
    );
    expect(billing.totals.count).toBe(2);
    expect(billing.attention).toEqual([]);
    const nobody = await server.json<OverviewResponse>(
      "/api/v1/overview?service=nobody",
    );
    expect(nobody.totals.count).toBe(0);
    expect(nobody.totals.apdex).toBeNull();
    expect(nobody.health.summary).toBe("No requests in the last 15 minutes.");

    const hour = await server.json<OverviewResponse>(
      "/api/v1/overview?service=shop&windowMinutes=60&apdexMs=1000",
    );
    expect(hour.windowMinutes).toBe(60);
    expect(hour.bucketMs).toBe(2 * MIN);
    expect(hour.series).toHaveLength(30);
    expect(hour.apdexMs).toBe(1000);
    // 700 ms requests are satisfied at T = 1000 ms (a bucket's upper edge counts).
    expect(hour.totals.count).toBe(51);
  });

  it("refuses bad parameters and stays closed without a session", async () => {
    for (const q of ["windowMinutes=30", "apdexMs=1", "nope=1"]) {
      expect((await server.get(`/api/v1/overview?${q}`)).status).toBe(400);
    }
    const closed = await startQueryServer(db.url, true, false);
    try {
      expect((await closed.get("/api/v1/overview")).status).not.toBe(200);
    } finally {
      await closed.close();
    }
  });
});
