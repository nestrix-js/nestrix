/**
 * `GET /api/v1/errors/insights` and the history fields of `errors/groups` (P15-02): the weekday x
 * hour grid, errors per release (events and requests), and the state of a group that went away
 * for a day and came back.
 */
import "reflect-metadata";
import type {
  ErrorGroupsResponse,
  ErrorInsightsResponse,
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
const HOUR = 3_600_000;
const NOW = Date.now();

const request = (n: number, agoMs: number, route: string, failing: boolean) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: `GET ${route}`,
    kind: "server",
    startMs: NOW - agoMs,
    durationMs: 10,
    attributes: { "http.request.method": "GET", "http.route": route },
    ...(failing
      ? {
          status: { code: "error" as const },
          events: [
            {
              name: "exception",
              timeUnixNano: BigInt(NOW - agoMs + 5) * 1_000_000n,
              attributes: {
                "exception.type": "BoomError",
                "exception.message": `order ${n} failed`,
              },
            },
          ],
        }
      : {}),
  });

describe.skipIf(noDatabase)(`error insights ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("errinsights");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    const v1 = { "service.version": "1.0.0" };
    const v2 = { "service.version": "1.1.0" };
    await sink.write(
      batch(
        "shop",
        [
          request(1, 50 * HOUR, "/orders", true),
          request(2, 49 * HOUR, "/orders", true),
          request(3, 49 * HOUR, "/users", false),
          request(4, 49 * HOUR, "/users", false),
        ],
        v1,
      ),
    );
    await sink.write(
      batch(
        "shop",
        [
          request(5, 60_000, "/orders", true),
          request(6, 50_000, "/users", false),
        ],
        v2,
      ),
    );
    await sink.write(
      batch("billing", [request(7, 40_000, "/invoices", true)], v2),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const insights = (q = "") =>
    server.json<ErrorInsightsResponse>(`/api/v1/errors/insights${q}`);

  it("counts error events into the weekday x hour grid (UTC) and per release", async () => {
    const r = await insights();
    expect(r.zone).toBe("UTC");
    expect(r.total).toBe(4);
    expect(r.heatmap).toHaveLength(7);
    expect(r.heatmap.every((row) => row.length === 24)).toBe(true);
    const cell = (agoMs: number) => {
      const d = new Date(NOW - agoMs);
      return r.heatmap[(d.getUTCDay() + 6) % 7]?.[d.getUTCHours()] ?? 0;
    };
    // Two of the events fell in one hour of one weekday 50 hours ago.
    expect(cell(50 * HOUR) + cell(49 * HOUR)).toBeGreaterThanOrEqual(2);
    expect(r.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(4);
    expect(r.releases.map((x) => x.release)).toEqual(["1.0.0", "1.1.0"]);
    expect(r.releases[0]).toMatchObject({
      events: 2,
      requests: 4,
      per1000Requests: 500,
    });
    expect(r.releases[1]).toMatchObject({
      events: 2,
      requests: 3,
    });
    expect(r.releases[1]?.per1000Requests).toBeCloseTo(666.67, 1);
    expect(r.coveredFromUnixMs).toBeLessThanOrEqual(NOW - 49 * HOUR);
    expect(r.toUnixMs - r.fromUnixMs).toBe(7 * 24 * HOUR);
  });

  it("filters by service and route", async () => {
    const billing = await insights("?service=billing");
    expect(billing.total).toBe(1);
    expect(billing.releases).toEqual([
      expect.objectContaining({ release: "1.1.0", events: 1, requests: 1 }),
    ]);
    const users = await insights(`?route=${encodeURIComponent("/users")}`);
    expect(users.total).toBe(0);
    expect(users.releases.map((x) => x.requests)).toEqual([2, 1]);
    const orders = await insights(`?route=${encodeURIComponent("/orders")}`);
    expect(orders.total).toBe(3);
    expect((await insights("?service=none")).total).toBe(0);
    expect(
      (await server.get(`/api/v1/errors/insights?route=${"x".repeat(600)}`))
        .status,
    ).toBe(400);
  });

  it("is closed without a session", async () => {
    const closed = await startQueryServer(db.url, true, false);
    try {
      expect((await closed.get("/api/v1/errors/insights")).status).not.toBe(
        200,
      );
    } finally {
      await closed.close();
    }
  });

  it("gives groups their history: first seen ever, releases and a regressed state", async () => {
    const r = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?service=shop",
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      pattern: "order <n> failed",
      route: "/orders",
      count: 1,
      state: "regressed",
      firstSeenRelease: "1.0.0",
      lastSeenRelease: "1.1.0",
      releases: [{ release: "1.1.0", count: 1 }],
    });
    expect(r.groups[0]?.firstEverUnixMs).toBeLessThan(NOW - 49 * HOUR);
    expect(r.history?.fromUnixMs).toBeLessThanOrEqual(
      NOW - 7 * 24 * HOUR + 1000,
    );
    // A group with nothing before the window is new.
    const billing = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?service=billing",
    );
    expect(billing.groups[0]?.state).toBe("new");
  });
});
