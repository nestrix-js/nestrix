/**
 * `traces.has_job` and the trace list's `type=job` filter: "Jobs" means "traces that include
 * job processing", whatever the root. A request that enqueued a job is processed (by a worker
 * service, in a later batch) as part of the request's trace.
 */
import "reflect-metadata";
import type { TraceListResponse } from "@nestrix-js/protocol";
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
const T0 = Date.now() - 90_000;
const REQ = tid(1); // request that later gets a job span
const PLAIN = tid(2); // request without a job
const JOB_ROOT = tid(3); // consumer root
const ENTRY = tid(4); // internal root with nestrix.entry = job

const http = (traceId: string, n: number, startMs: number) =>
  span({
    traceId,
    spanId: sid(n),
    name: "GET /x",
    kind: "server",
    startMs,
    durationMs: 10,
    attributes: { "http.request.method": "GET", "http.route": "/x" },
  });

describe.skipIf(noDatabase)(`trace list has_job ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("hasjob");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("shop", [http(REQ, 1, T0), http(PLAIN, 2, T0 + 100)]),
    );
    await sink.write(
      batch("worker", [
        span({
          traceId: JOB_ROOT,
          spanId: sid(3),
          name: "q process",
          kind: "consumer",
          startMs: T0 + 200,
          durationMs: 5,
        }),
        span({
          traceId: ENTRY,
          spanId: sid(4),
          name: "Mailer.send",
          startMs: T0 + 300,
          durationMs: 5,
          attributes: { "nestrix.entry": "job" },
        }),
      ]),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const list = (q = "") => server.json<TraceListResponse>(`/api/v1/traces${q}`);
  const ids = (r: TraceListResponse) => r.items.map((i) => i.traceId);

  it("is false until a job span arrives, then true on the request's trace in any later batch", async () => {
    expect(ids(await list("?type=job")).sort()).toEqual(
      [ENTRY, JOB_ROOT].sort(),
    );
    const before = (await list()).items.find((i) => i.traceId === REQ);
    expect(before).toMatchObject({ type: "http", hasJob: false });

    // The job finishes after the request: a consumer span, child of the request span.
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("worker", [
        span({
          traceId: REQ,
          spanId: sid(5),
          parentSpanId: sid(1),
          name: "q process",
          kind: "consumer",
          startMs: T0 + 50,
          durationMs: 5,
        }),
      ]),
    );
    // A later batch without a job span must not clear it (OR semantics).
    await sink.write(
      batch("shop", [
        span({
          traceId: REQ,
          spanId: sid(6),
          parentSpanId: sid(1),
          name: "after",
          startMs: T0 + 60,
          durationMs: 1,
        }),
      ]),
    );
    const all = await list();
    const req = all.items.find((i) => i.traceId === REQ);
    // The root stays the request: type is unchanged, hasJob flipped.
    expect(req).toMatchObject({ type: "http", hasJob: true, spanCount: 3 });
    expect(all.items.find((i) => i.traceId === PLAIN)?.hasJob).toBe(false);
    expect(all.items.find((i) => i.traceId === JOB_ROOT)?.hasJob).toBe(true);
    expect(all.items.find((i) => i.traceId === ENTRY)?.hasJob).toBe(true);
  });

  it("type=job returns every trace with job processing; type=http stays root-based", async () => {
    expect(ids(await list("?type=job")).sort()).toEqual(
      [REQ, JOB_ROOT, ENTRY].sort(),
    );
    expect(ids(await list("?type=http")).sort()).toEqual([REQ, PLAIN].sort());
    expect(ids(await list("?type=other"))).toEqual([]);
  });
});
