/**
 * `GET /api/v1/errors/groups` (P9-04): error spans of the window grouped by (type, normalised
 * message, route of the trace's root), with per-service filtering.
 */
import "reflect-metadata";
import type { ErrorGroupsResponse } from "@nestrix-js/protocol";
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
const T0 = Date.now() - 120_000;

const failing = (n: number, id: number, route: string) => [
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: `GET ${route}`,
    kind: "server",
    startMs: T0 + n * 1000,
    durationMs: 10,
    attributes: { "http.request.method": "GET", "http.route": route },
    status: { code: "error" },
    events: [
      {
        name: "exception",
        timeUnixNano: BigInt(T0 + n * 1000 + 5) * 1_000_000n,
        attributes: {
          "exception.type": "NotFoundException",
          "exception.message": `user ${id} not found`,
        },
      },
    ],
  }),
];

describe.skipIf(noDatabase)(`error groups ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("errgroups");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(batch("shop", failing(1, 42, "/users/:id")));
    await sink.write(batch("shop", failing(2, 7, "/users/:id")));
    await sink.write(batch("billing", failing(3, 9, "/users/:id")));
    await sink.write(batch("shop", failing(4, 1, "/accounts/:id")));
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const groups = (q = "") =>
    server.json<ErrorGroupsResponse>(`/api/v1/errors/groups${q}`);

  it("groups user 42 / 7 / 9 together, per route, with services and a series", async () => {
    const r = await groups();
    expect(r.windowMinutes).toBe(15);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]).toMatchObject({
      errorType: "NotFoundException",
      pattern: "user <n> not found",
      route: "/users/:id",
      count: 3,
      services: ["billing", "shop"],
      exampleTraceId: tid(3),
      latestMessage: "user 9 not found",
    });
    expect(r.groups[0]?.series.reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.groups[0]?.recent.map((o) => o.traceId)).toEqual([
      tid(3),
      tid(2),
      tid(1),
    ]);
    expect(r.groups[1]).toMatchObject({ route: "/accounts/:id", count: 1 });
  });

  it("filters by service and rejects a bad window", async () => {
    const shop = await groups("?service=shop");
    expect(shop.groups[0]).toMatchObject({ count: 2, services: ["shop"] });
    expect((await groups("?service=none")).groups).toEqual([]);
    expect(
      (await server.get("/api/v1/errors/groups?windowMinutes=30")).status,
    ).toBe(400);
  });
});
