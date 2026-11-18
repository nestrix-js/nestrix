/**
 * `GET /api/v1/classes` over an explicit historical range (audit, D-107): own time is estimated
 * from the method spans that started inside the range, like the calls and total time from the
 * rollups. Regression: the current side had no upper bound, so a later slow call raised an
 * earlier window's own time, even above its total time.
 */
import "reflect-metadata";
import type { ClassStatsResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const MIN = 60_000;
/** The end of the historical window: three hours ago, on a minute. */
const END = Math.floor((Date.now() - 3 * 3_600_000) / MIN) * MIN;
const FROM = END - 15 * MIN;

describe.skipIf(noDatabase)(`own time over a range ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("ownwindow");
    server = await startQueryServer(db.url);
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  async function call(startMs: number, durationMs: number): Promise<void> {
    const traceId = hex(16);
    const root = hex(8);
    await server.app.get(PostgresIngestSink).write(
      batch("hist", [
        span({
          traceId,
          spanId: root,
          name: "GET /report",
          kind: "server",
          startMs,
          durationMs: durationMs + 2,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/report",
            "http.response.status_code": 200,
          },
        }),
        span({
          traceId,
          parentSpanId: root,
          name: "ReportService.build",
          kind: "internal",
          startMs: startMs + 1,
          durationMs,
          attributes: {
            "nestrix.class": "ReportService",
            "nestrix.method": "build",
          },
        }),
      ]),
    );
  }

  const read = async () => {
    const r = await server.json<ClassStatsResponse>(
      `/api/v1/classes?service=hist&fromUnixMs=${FROM}&toUnixMs=${END}`,
    );
    const c = r.classes.find((x) => x.className === "ReportService");
    return {
      calls: c?.calls,
      totalMs: c?.totalMs,
      ownMs: c?.ownMs,
      ownAvgMs: c?.methods[0]?.ownAvgMs,
    };
  };

  it("does not change an earlier window's numbers when a later slow call arrives", async () => {
    await call(FROM + 5 * MIN, 10);
    await call(END - 2 * MIN, 20);
    const before = await read();
    expect(before).toEqual({ calls: 2, totalMs: 30, ownMs: 30, ownAvgMs: 15 });

    // Ten minutes after the window ends, and much slower.
    await call(END + 10 * MIN, 5_000);
    const after = await read();
    expect(after).toEqual(before);
    expect(after.ownMs).toBeLessThanOrEqual(after.totalMs ?? 0);
  });
});
