/**
 * P12-01: `GET /api/v1/routes/explain` on the standalone server. The computation itself is tested
 * in `packages/nestjs/test/explain-compute-unit.test.ts`; `explain-compute.ts` here must stay a
 * byte-identical copy of that module (the first test). The route tests run against PostgreSQL.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RouteExplainResponse } from "@nestrix-js/protocol";
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

describe("explain-compute.ts", () => {
  it("is a byte-identical copy of the embedded dashboard's module", () => {
    const here = (p: string) =>
      readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    expect(here("../../src/query/explain-compute.ts")).toBe(
      here("../../../../packages/nestjs/src/explain/compute.ts"),
    );
  });
});

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
const MIN = 60_000;
const NOW = Date.now();
const STATEMENT = "SELECT * FROM order_items WHERE order_id = $1";
const PG = {
  "db.system.name": "postgresql",
  "server.address": "db.local",
  "db.query.text": STATEMENT,
};

const root = (
  n: number,
  startMs: number,
  durationMs: number,
  extra: { status?: number; error?: boolean; route?: string } = {},
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
      "http.route": extra.route ?? "/orders",
      "http.response.status_code": extra.status ?? 200,
    },
    ...(extra.error
      ? { status: { code: "error" as const, message: "boom" } }
      : {}),
  });

describe.skipIf(noDatabase)(`route explain endpoint ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("explain");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    const prev = Math.floor((NOW - 75 * MIN) / MIN) * MIN;
    const cur = Math.floor((NOW - 8 * MIN) / MIN) * MIN;

    // shop, release 1.0, inside the previous 60-minute window: 6 fast requests.
    const before = [];
    for (let i = 0; i < 6; i++) before.push(root(100 + i, prev + i * 1000, 20));
    await sink.write(batch("shop", before, { "service.version": "1.0" }));

    // shop, release 2.0, current window: 6 slower requests, each with the statement run 4 times;
    // two fail with an exception event.
    const after = [];
    for (let i = 0; i < 6; i++) {
      const failing = i < 2;
      after.push(
        root(200 + i, cur + i * 1000, 40, {
          status: failing ? 500 : 200,
          error: failing,
        }),
      );
      for (let k = 0; k < 4; k++) {
        after.push(
          span({
            traceId: tid(200 + i),
            spanId: sid(1000 + i * 10 + k),
            parentSpanId: sid(200 + i),
            name: "pg.query",
            kind: "client",
            startMs: cur + i * 1000 + 2 + k * 5,
            durationMs: 4,
            attributes: PG,
          }),
        );
      }
      if (failing) {
        after.push(
          span({
            traceId: tid(200 + i),
            spanId: sid(2000 + i),
            parentSpanId: sid(200 + i),
            name: "PaymentService.charge",
            kind: "internal",
            startMs: cur + i * 1000 + 25,
            durationMs: 3,
            attributes: {
              "nestrix.class": "PaymentService",
              "nestrix.method": "charge",
            },
            events: [
              {
                name: "exception",
                timeUnixNano: BigInt(cur + i * 1000 + 27) * 1_000_000n,
                attributes: {
                  "exception.type": "PaymentGatewayError",
                  "exception.message": "card declined",
                },
              },
            ],
          }),
        );
      }
    }
    await sink.write(batch("shop", after, { "service.version": "2.0" }));

    // Another route of shop, and the same route of another service.
    await sink.write(
      batch("shop", [root(300, cur, 500, { route: "/other" })], {
        "service.version": "2.0",
      }),
    );
    await sink.write(
      batch("billing", [root(400, cur, 10), root(401, cur + 1000, 10)]),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("explains a window change: shape, N+1 finding, new error, kinds", async () => {
    const r = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&method=get&windowMinutes=15&service=shop",
    );
    expect(r.mode).toBe("window");
    expect(r.method).toBe("GET");
    expect(r.route).toBe("/orders");
    // The previous 15-minute window holds nothing: the 20 ms requests are 75 minutes old.
    expect(r.before.traces).toBe(0);
    expect(r.after).toMatchObject({ label: "current", traces: 6 });
    expect(r.after.errorRate).toBeCloseTo(2 / 6);
    expect(r.releases).toEqual(["2.0", "1.0"]);
    expect(r.summary).toBe("Not enough traces to compare (0 before, 6 after).");
    expect(r.statements[0]).toMatchObject({
      statement: STATEMENT,
      system: "postgresql",
      afterCalls: 4,
    });
    expect(r.errors).toEqual([
      {
        type: "PaymentGatewayError",
        message: "card declined",
        beforeTraces: 0,
        afterTraces: 2,
      },
    ]);
    expect(r.methods[0]).toMatchObject({
      name: "PaymentService.charge",
      afterCalls: 0.333,
    });
    expect(r.dependencies[0]).toMatchObject({
      kind: "db",
      name: "postgresql",
      afterCalls: 4,
    });
    expect(r.kinds).toHaveLength(6);
    expect(r.slowest).toHaveLength(6);
    expect(r.slowest[0]?.durationMs).toBe(40);

    // A 60-minute window reaches the old requests: findings need both sides.
    const hour = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&windowMinutes=60&service=shop",
    );
    expect(hour.before.traces).toBe(6);
    expect(hour.after.traces).toBe(6);
    const kinds = hour.findings.map((f) => f.kind);
    expect(kinds).toContain("n-plus-one");
    expect(kinds).toContain("new-error");
    expect(hour.findings[0]).toMatchObject({
      kind: "n-plus-one",
      link: { view: "queries", params: { q: STATEMENT } },
    });
    expect(hour.summary).toMatch(/^Mean time went from 20 ms to 40 ms/);
  });

  it("compares two releases, and honours the service filter", async () => {
    const r = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&releaseA=1.0&releaseB=2.0",
    );
    expect(r.mode).toBe("release");
    expect(r.before).toMatchObject({ label: "1.0", traces: 6, meanMs: 20 });
    expect(r.after).toMatchObject({ label: "2.0", traces: 6, meanMs: 40 });
    expect(r.findings.map((f) => f.kind)).toContain("n-plus-one");

    const all = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&windowMinutes=15",
    );
    // billing's two requests of the same route join in without a service filter.
    expect(all.after.traces).toBe(8);
    const billing = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&windowMinutes=15&service=billing",
    );
    expect(billing.after.traces).toBe(2);
    expect(billing.releases).toEqual([]);
    const nobody = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/orders&service=nobody",
    );
    expect(nobody.after.traces).toBe(0);
    const unknown = await server.json<RouteExplainResponse>(
      "/api/v1/routes/explain?route=/nope",
    );
    expect(unknown.findings).toEqual([]);
    expect(unknown.releases).toEqual([]);
  });

  it("refuses a missing route, one release, and bad parameters", async () => {
    for (const q of [
      "",
      "route=/orders&releaseA=1.0",
      "route=/orders&releaseB=2.0",
      "route=/orders&windowMinutes=30",
      "route=/orders&nope=1",
    ]) {
      expect((await server.get(`/api/v1/routes/explain?${q}`)).status, q).toBe(
        400,
      );
    }
  });

  it("stays closed without a session", async () => {
    const closed = await startQueryServer(db.url, true, false);
    try {
      expect(
        (await closed.get("/api/v1/routes/explain?route=/orders")).status,
      ).not.toBe(200);
    } finally {
      await closed.close();
    }
    const denied = await startQueryServer(db.url, false);
    try {
      expect(
        (await denied.get("/api/v1/routes/explain?route=/orders")).status,
      ).not.toBe(200);
    } finally {
      await denied.close();
    }
  });
});
