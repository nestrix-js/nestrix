/**
 * Window ends are exclusive (audit, D-107): a span that starts between two windows (microseconds
 * before the next window's first millisecond) belongs to the previous one. Regression: the
 * previous side ended at `curFrom - 1` inclusive and the current side started at `curFrom`, so a
 * start in `(curFrom - 1 ms, curFrom)` was in neither.
 */
import "reflect-metadata";
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
    await server.app
      .get(PostgresIngestSink)
      .write(
        batch("shop", [
          failing("a", BigInt(T) * 1_000_000n - 400_000n),
          failing("b", BigInt(T) * 1_000_000n),
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
});
