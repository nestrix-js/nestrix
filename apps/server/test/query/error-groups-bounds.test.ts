/**
 * `GET /api/v1/errors/groups` over an explicit historical range (audit, D-107): the window's end
 * bounds the read in SQL before the newest-first row cap, and the groups are built from the span
 * start time the SQL bounds by. Regression: the in-window read had a start but no end, so more
 * than one page (5,000) of newer errors crowded every in-range occurrence out, and an occurrence
 * up to one bucket after the end was still counted.
 */
import "reflect-metadata";
import type { ErrorGroupsResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryService } from "../../src/query/query.service.js";
import { ALL } from "../../src/query/scope.js";
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

const MIN = 60_000;
const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
/** The end of the historical window: two hours ago, on a minute. */
const H = Math.floor((Date.now() - 2 * 3_600_000) / MIN) * MIN;
const FROM = H - 15 * MIN;
/** More than one page of the in-window cap (5,000). */
const NEWER = 5_200;

const failing = (
  n: number,
  startMs: number,
  type: string,
  message: string,
  route: string,
) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: `GET ${route}`,
    kind: "server",
    startMs,
    durationMs: 10,
    attributes: { "http.request.method": "GET", "http.route": route },
    status: { code: "error" },
    events: [
      {
        name: "exception",
        timeUnixNano: BigInt(Math.floor(startMs) + 5) * 1_000_000n,
        attributes: { "exception.type": type, "exception.message": message },
      },
    ],
  });

describe.skipIf(noDatabase)(`error groups bounds ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("errbounds");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    // The quiet historical window: three occurrences of one group.
    await sink.write(
      batch("shop", [
        failing(1, FROM + 2 * MIN, "OldError", "order 1 failed", "/old"),
        failing(2, FROM + 7 * MIN, "OldError", "order 2 failed", "/old"),
        failing(3, H - MIN, "OldError", "order 3 failed", "/old"),
        // 30 s after the end: inside the bucket after it, so not in the window.
        failing(4, H + 30_000, "OldError", "order 4 failed", "/old"),
      ]),
    );
    // Then more than a page of newer errors, all after the window.
    const newer = [];
    for (let i = 0; i < NEWER; i++) {
      newer.push(
        failing(
          1000 + i,
          H + 10 * MIN + i * 10,
          "NewError",
          `job ${i} failed`,
          "/new",
        ),
      );
    }
    for (let i = 0; i < newer.length; i += 2000) {
      await sink.write(batch("shop", newer.slice(i, i + 2000)));
    }
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("counts the historical window's groups exactly under a page of newer errors", async () => {
    const r = await server.json<ErrorGroupsResponse>(
      `/api/v1/errors/groups?fromUnixMs=${FROM}&toUnixMs=${H}`,
    );
    expect(r.toUnixMs).toBe(H);
    expect(r.groups.map((g) => [g.errorType, g.count])).toEqual([
      ["OldError", 3],
    ]);
    const old = r.groups[0];
    expect(old?.series.reduce((a, b) => a + b, 0)).toBe(3);
    expect(old?.lastSeenUnixMs).toBeLessThanOrEqual(H);
    expect(r.truncated).toBeUndefined();
  });

  it("gives Overview's previous period (a window ending before now) the same exact groups", async () => {
    const query = server.app.get(QueryService);
    const r = await query.errorGroups(15, ALL, H);
    expect(r.groups.map((g) => [g.errorType, g.count])).toEqual([
      ["OldError", 3],
    ]);
  });
});
