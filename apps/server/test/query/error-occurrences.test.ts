/**
 * Error occurrences and `hasErrors` in the standalone server (D-93, D-94), against Postgres:
 * propagated and expected exceptions are left out of `errors`, `errors/groups` and
 * `errors/insights`; spans from SDKs that do not mark propagation keep the deepest span; two
 * different errors stay two; `traces?hasErrors=` finds a trace whose root succeeded but a span
 * failed, and reads rows stored before migration 0012 from `error_count`.
 */
import "reflect-metadata";
import type {
  ErrorGroupsResponse,
  ErrorInsightsResponse,
  ErrorListResponse,
  TraceListResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestSpan } from "../../src/ingest/model.js";
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
const sid = (n: number, k = 0) => (n * 16 + k).toString(16).padStart(16, "0");
const NOW = Date.now();

const exception = (
  message: string,
  marks: Record<string, boolean | string> = {},
) => ({
  name: "exception",
  timeUnixNano: BigInt(NOW - 5_000) * 1_000_000n,
  attributes: {
    "exception.type": "Error",
    "exception.message": message,
    "exception.stacktrace": `Error: ${message}\n    at here (app.js:1:1)`,
    ...marks,
  },
});
const ERROR = { code: "error" as const };

function root(
  n: number,
  route: string,
  opts: { status?: number; error?: boolean; events?: IngestSpan["events"] },
): IngestSpan {
  return span({
    traceId: tid(n),
    spanId: sid(n),
    name: `GET ${route}`,
    kind: "server",
    startMs: NOW - 6_000,
    durationMs: 20,
    attributes: {
      "http.request.method": "GET",
      "http.route": route,
      "http.response.status_code": opts.status ?? 200,
    },
    ...(opts.error ? { status: ERROR } : {}),
    events: opts.events ?? [],
  });
}

function child(
  n: number,
  k: number,
  name: string,
  events: IngestSpan["events"],
  parent = sid(n),
): IngestSpan {
  return span({
    traceId: tid(n),
    spanId: sid(n, k),
    parentSpanId: parent,
    name,
    startMs: NOW - 5_990,
    durationMs: 5,
    status: ERROR,
    events,
  });
}

describe.skipIf(noDatabase)(`error occurrences ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  beforeAll(async () => {
    db = await createTestDb("erroccur");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("shop", [
        // 1: thrown in the handler; the server span's event is propagation.
        child(1, 1, "AppController.boom", [exception("boom")]),
        root(1, "/boom", {
          status: 500,
          error: true,
          events: [exception("boom", { "nestrix.exception.propagated": true })],
        }),
        // 2: a thrown 404: expected on both spans.
        child(2, 1, "AppController.find", [
          exception("nope", { "nestrix.exception.expected": true }),
        ]),
        root(2, "/find", {
          status: 404,
          events: [exception("nope", { "nestrix.exception.expected": "true" })],
        }),
        // 3: an older SDK, no marks: parent and child carry the same exception.
        child(3, 1, "LegacyController.boom", [exception("legacy")]),
        root(3, "/legacy", {
          status: 500,
          error: true,
          events: [exception("legacy")],
        }),
        // 4: two different errors in one trace.
        child(4, 1, "first-step", [exception("first of two")]),
        root(4, "/two", {
          status: 500,
          error: true,
          events: [exception("second of two")],
        }),
        // 5: the request answered 200; a job span inside it failed.
        child(5, 1, "OrdersProcessor.process", [exception("job broke")]),
        root(5, "/enqueue", {}),
        // 6: fine.
        root(6, "/ok", {}),
      ]),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("errors: one per thrown error, on the deepest span; expected ones left out", async () => {
    const list = await server.json<ErrorListResponse>(
      "/api/v1/errors?limit=200",
    );
    const of = (n: number) =>
      list.items
        .filter((i) => i.traceId === tid(n))
        .map((i) => i.spanName)
        .sort();
    expect(of(1)).toEqual(["AppController.boom"]);
    expect(of(2)).toEqual([]);
    expect(of(3)).toEqual(["LegacyController.boom"]);
    expect(of(4)).toEqual(["GET /two", "first-step"]);
    expect(of(5)).toEqual(["OrdersProcessor.process"]);
    expect(list.items).toHaveLength(5);
    const first = list.items.find((i) => i.traceId === tid(1));
    expect(first).toMatchObject({ errorType: "Error", message: "boom" });
  });

  it("errors/groups and errors/insights count the same occurrences", async () => {
    const groups = await server.json<ErrorGroupsResponse>(
      "/api/v1/errors/groups?windowMinutes=15",
    );
    const count = (pattern: string) =>
      groups.groups.find((g) => g.pattern === pattern)?.count;
    expect(count("boom")).toBe(1);
    expect(count("legacy")).toBe(1);
    expect(count("first of two")).toBe(1);
    expect(count("second of two")).toBe(1);
    expect(count("nope")).toBeUndefined();
    const insights = await server.json<ErrorInsightsResponse>(
      "/api/v1/errors/insights",
    );
    expect(insights.total).toBe(5);
  });

  it("hasErrors: set when any span failed; the filter finds it; status=error stays the root's", async () => {
    const all = await server.json<TraceListResponse>(
      "/api/v1/traces?limit=200",
    );
    const item = (n: number) => all.items.find((i) => i.traceId === tid(n));
    expect(item(5)).toMatchObject({ error: false, hasErrors: true });
    expect(item(2)).toMatchObject({ error: false, hasErrors: false });
    expect(item(1)).toMatchObject({ error: true, hasErrors: true });
    expect(item(6)).toMatchObject({ error: false, hasErrors: false });
    const ids = async (q: string) =>
      (
        await server.json<TraceListResponse>(`/api/v1/traces?limit=200&${q}`)
      ).items
        .map((i) => i.traceId)
        .sort();
    expect(await ids("hasErrors=true")).toEqual(
      [tid(1), tid(3), tid(4), tid(5)].sort(),
    );
    expect(await ids("hasErrors=false")).toEqual([tid(2), tid(6)].sort());
    expect(await ids("status=error")).toEqual([tid(1), tid(3), tid(4)].sort());
    const timeline = await server.json<{ totals?: unknown }>(
      "/api/v1/traces/timeline?hasErrors=true",
    );
    expect(timeline).toBeDefined();
    expect((await server.get("/api/v1/traces?hasErrors=yes")).status).toBe(400);
  });

  it("rows from before migration 0012 (NULL) fall back to error_count, and new spans merge into them", async () => {
    await db.pool.query(
      "UPDATE traces SET has_errors = NULL WHERE trace_id = ANY($1)",
      [[tid(5), tid(6)]],
    );
    const ids = async () =>
      (
        await server.json<TraceListResponse>(
          "/api/v1/traces?limit=200&hasErrors=true",
        )
      ).items.map((i) => i.traceId);
    expect(await ids()).toContain(tid(5));
    expect(await ids()).not.toContain(tid(6));
    // A late failed span of trace 6 arrives: the merged row is exact again.
    await server.app
      .get(PostgresIngestSink)
      .write(batch("shop", [child(6, 1, "late", [exception("late")])]));
    expect(await ids()).toContain(tid(6));
    const row = await db.pool.query<{ has_errors: boolean | null }>(
      "SELECT has_errors FROM traces WHERE trace_id = $1",
      [tid(6)],
    );
    expect(row.rows[0]?.has_errors).toBe(true);
  });
});
