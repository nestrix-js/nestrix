/**
 * Window ends are exclusive (audit, D-107): a span that starts between two windows (microseconds
 * before the next window's first millisecond) belongs to the previous one. Regression: the
 * previous side ended at `curFrom - 1` inclusive and the current side started at `curFrom`, so a
 * start in `(curFrom - 1 ms, curFrom)` was in neither.
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OverviewService } from "../../src/query/overview.service.js";
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
/** A minute boundary, an hour ago: the current window's first millisecond. */
const T = Math.floor((Date.now() - 60 * MIN) / MIN) * MIN;

describe.skipIf(noDatabase)(`window ends are exclusive ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("winends");
    server = await startQueryServer(db.url);
    const failing = (id: string, startNs: bigint) => ({
      ...span({
        traceId: id.repeat(32),
        spanId: id.repeat(16),
        name: "GET /gap",
        kind: "server",
        startMs: 0,
        durationMs: 1,
        attributes: { "http.request.method": "GET", "http.route": "/gap" },
        status: { code: "error" as const },
        events: [
          {
            name: "exception",
            timeUnixNano: startNs + 500_000n,
            attributes: {
              "exception.type": "GapError",
              "exception.message": "x",
            },
          },
        ],
      }),
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs + 1_000_000n,
    });
    const outbound = (id: string, startNs: bigint) => ({
      ...span({
        traceId: id.repeat(32),
        spanId: id.repeat(16),
        name: "pg.query",
        kind: "client",
        startMs: 0,
        durationMs: 1,
        attributes: {
          "db.system.name": "postgresql",
          "server.address": "db.local",
          "db.namespace": "shop",
        },
      }),
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs + 1_000_000n,
    });
    const before = BigInt(T) * 1_000_000n - 400_000n;
    const at = BigInt(T) * 1_000_000n;
    await server.app
      .get(PostgresIngestSink)
      .write(
        batch("shop", [
          failing("a", before),
          failing("b", at),
          outbound("c", before),
          outbound("d", at),
        ]),
      );
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("counts a span at T - 0.4 ms in the previous window and not in the current one", async () => {
    const query = server.app.get(QueryService);
    // The windows Overview reads: previous ends at the current window's first millisecond.
    const previous = await query.errorGroups(15, ALL, T - 1);
    const current = await query.errorGroups(15, ALL, T + 14 * MIN + 30_000);
    expect(current.fromUnixMs).toBe(T);
    expect(previous.groups[0]?.count).toBe(1);
    expect(current.groups[0]?.count).toBe(1);
  });

  it("dependencies: the previous window holds the call at T - 0.4 ms, the current one the call at T", async () => {
    const query = server.app.get(QueryService);
    const previous = await query.dependencies(15, ALL, T - 1);
    const current = await query.dependencies(15, ALL, T + 14 * MIN + 30_000);
    expect(previous.dependencies.map((d) => d.calls)).toEqual([1]);
    expect(current.dependencies.map((d) => d.calls)).toEqual([1]);
  });

  it("map: the previous window holds the call at T - 0.4 ms, the current one the call at T", async () => {
    const query = server.app.get(QueryService);
    const previous = await query.map(15, ALL, T - 1);
    const current = await query.map(15, ALL, T + 14 * MIN + 30_000);
    expect(previous.edges.map((e) => e.calls)).toEqual([1]);
    expect(current.edges.map((e) => e.calls)).toEqual([1]);
  });

  it("status mix: the current window ends at now + 1 ms, so a root at T - 0.4 ms counts for now = T - 1", async () => {
    const overview = server.app.get(OverviewService);
    const inside = await overview.overview(15, 300, ALL, T - 1);
    expect(inside.status.serverError).toBe(1);
    // The root at T is the next window's: not in this one, in the one that ends after it.
    const later = await overview.overview(15, 300, ALL, T);
    expect(later.status.serverError).toBe(2);
  });
});
