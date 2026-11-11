import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IngestBusyError } from "../../src/ingest/model.js";
import {
  bucketIndex,
  estimateQuantile,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../../src/storage/histogram.js";
import { runMigrations } from "../../src/storage/migrate.js";
import { PartitionManager } from "../../src/storage/partitions.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  nsAt,
  skipReason,
  span,
  type TestDb,
} from "./helpers.js";

describe.skipIf(noDatabase)(`ingest writer ${skipReason}`, () => {
  let db: TestDb;
  let partitions: PartitionManager;
  const now = Date.now();

  beforeAll(async () => {
    db = await createTestDb("writer");
    await runMigrations(db.pool);
    partitions = new PartitionManager(db.pool, { retentionDays: 7 });
    await partitions.start();
    partitions.stop();
  });
  afterAll(async () => {
    await db?.drop();
  });

  const trace = async (traceId: string) =>
    (await db.pool.query("SELECT * FROM traces WHERE trace_id = $1", [traceId]))
      .rows;

  it("stores spans with extracted columns, one resource per distinct resource, and the trace summary", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const traceId = hex(16);
    const rootId = hex(8);
    const childId = hex(8);
    const service = `svc-${hex(3)}`;
    await sink.write(
      batch(
        service,
        [
          span({
            traceId,
            spanId: rootId,
            name: "GET /users/:id",
            kind: "server",
            startMs: now,
            durationMs: 42.5,
            attributes: {
              "http.request.method": "GET",
              "http.route": "/users/:id",
              "http.response.status_code": 200,
              "user.id": "u-1",
              tags: ["a", "b"],
            },
          }),
          span({
            traceId,
            spanId: childId,
            parentSpanId: rootId,
            name: "UsersService.find",
            startMs: now + 1,
            durationMs: 10,
            attributes: {
              "nestrix.class": "UsersService",
              "nestrix.method": "find",
              "nestrix.component": "service",
            },
            status: { code: "error", message: "boom" },
            events: [
              {
                name: "exception",
                timeUnixNano: nsAt(now + 5),
                attributes: {
                  "exception.type": "Error",
                  "exception.message": "boom",
                },
              },
            ],
          }),
        ],
        { "service.version": "1.2.3" },
      ),
    );

    const { rows: spans } = await db.pool.query(
      "SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_ns",
      [traceId],
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      span_id: rootId,
      parent_span_id: null,
      service_name: service,
      kind: "server",
      start_ns: nsAt(now).toString(),
      duration_ns: "42500000",
      http_route: "/users/:id",
      http_method: "GET",
      http_status: 200,
      is_root: true,
      is_error: false,
      trace_type: "http",
      user_id: "u-1",
      scope: "test",
      attributes: expect.objectContaining({ tags: ["a", "b"] }),
    });
    expect(spans[0].start_time.getTime()).toBe(now);
    expect(spans[1]).toMatchObject({
      parent_span_id: rootId,
      is_root: false,
      is_error: true,
      status_message: "boom",
      class_name: "UsersService",
      method_name: "find",
      trace_type: "other",
      events: [
        {
          name: "exception",
          timeUnixNano: nsAt(now + 5).toString(),
          attributes: {
            "exception.type": "Error",
            "exception.message": "boom",
          },
        },
      ],
    });

    const { rows: resources } = await db.pool.query(
      "SELECT * FROM resources WHERE service_name = $1",
      [service],
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ service_version: "1.2.3" });
    expect(spans[0].resource_id).toBe(resources[0].id);

    const [summary] = await trace(traceId);
    expect(summary).toMatchObject({
      root_span_id: rootId,
      root_parent_span_id: null,
      service_name: service,
      name: "GET /users/:id",
      kind: "server",
      http_method: "GET",
      http_route: "/users/:id",
      http_status: 200,
      is_error: false,
      trace_type: "http",
      release: "1.2.3",
      user_id: "u-1",
      span_count: 2,
      error_count: 1,
      services: [service],
      duration_ns: "42500000",
    });
    expect([...summary.span_names].sort()).toEqual([
      "GET /users/:id",
      "UsersService.find",
    ]);

    // The same resource again: no second row.
    await sink.write(
      batch(
        service,
        [span({ traceId: hex(16), startMs: now, durationMs: 1 })],
        {
          "service.version": "1.2.3",
        },
      ),
    );
    const { rows: again } = await db.pool.query(
      "SELECT count(*)::int AS n FROM resources WHERE service_name = $1",
      [service],
    );
    expect(again[0].n).toBe(1);
    const { rows: svc } = await db.pool.query(
      "SELECT * FROM services WHERE name = $1",
      [service],
    );
    expect(svc).toHaveLength(1);
  });

  it("a retried export is not stored or counted twice", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const traceId = hex(16);
    const service = `retry-${hex(3)}`;
    const b = batch(service, [
      span({
        traceId,
        kind: "server",
        startMs: now,
        durationMs: 3,
        attributes: { "http.request.method": "POST", "http.route": "/r" },
      }),
      span({ traceId, startMs: now, durationMs: 1 }),
    ]);
    await sink.write(b);
    await sink.write(b);
    expect(sink.stats()).toMatchObject({ writtenSpans: 2, duplicateSpans: 2 });
    const [summary] = await trace(traceId);
    expect(summary.span_count).toBe(2);
    const { rows } = await db.pool.query(
      "SELECT sum(count)::int AS n FROM route_minutes WHERE service_name = $1",
      [service],
    );
    expect(rows[0].n).toBe(1);

    // The same span twice in one batch: stored and counted once.
    const twiceTrace = hex(16);
    const once = span({
      traceId: twiceTrace,
      kind: "server",
      startMs: now,
      durationMs: 2,
      attributes: { "http.request.method": "PUT", "http.route": "/twice" },
    });
    await sink.write(batch(service, [once, { ...once }]));
    const [twice] = await trace(twiceTrace);
    expect(twice.span_count).toBe(1);
    const { rows: twiceRoutes } = await db.pool.query(
      "SELECT count FROM route_minutes WHERE service_name = $1 AND route = '/twice'",
      [service],
    );
    expect(twiceRoutes).toEqual([{ count: 1 }]);
  });

  it("settles a trace on its true root when the root arrives after its descendants, from another service", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const traceId = hex(16);
    const rootId = hex(8);
    const clientId = hex(8);
    const serverId = hex(8);
    // Service B's server span arrives first; its parent (A's client span) is not stored yet.
    await sink.write(
      batch("svc-b", [
        span({
          traceId,
          spanId: serverId,
          parentSpanId: clientId,
          name: "GET /inner",
          kind: "server",
          startMs: now + 10,
          durationMs: 20,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/inner",
            "user.id": "b-user",
          },
        }),
      ]),
    );
    let [summary] = await trace(traceId);
    expect(summary).toMatchObject({
      root_span_id: serverId,
      root_parent_span_id: clientId,
      span_count: 1,
    });
    const seq = summary.seq;

    // Service A's client span arrives (it has a parent too, and its clock is behind):
    // it is the stored root's parent, so it replaces it.
    await sink.write(
      batch("svc-a", [
        span({
          traceId,
          spanId: clientId,
          parentSpanId: rootId,
          name: "GET",
          kind: "client",
          startMs: now + 20,
          durationMs: 25,
        }),
      ]),
    );
    [summary] = await trace(traceId);
    expect(summary).toMatchObject({ root_span_id: clientId, span_count: 2 });

    // A's root (no parent) arrives last.
    await sink.write(
      batch("svc-a", [
        span({
          traceId,
          spanId: rootId,
          name: "GET /outer",
          kind: "server",
          startMs: now,
          durationMs: 50,
          attributes: { "http.request.method": "GET", "http.route": "/outer" },
        }),
      ]),
    );
    const rows = await trace(traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      root_span_id: rootId,
      root_parent_span_id: null,
      name: "GET /outer",
      service_name: "svc-a",
      http_route: "/outer",
      span_count: 3,
      services: ["svc-a", "svc-b"],
      // The root has no user.id; the first one seen in the trace is kept.
      user_id: "b-user",
      seq,
    });

    // A later span with a parent does not displace a parentless root, even if it starts earlier.
    await sink.write(
      batch("svc-c", [
        span({
          traceId,
          parentSpanId: hex(8),
          startMs: now - 100,
          durationMs: 1,
        }),
      ]),
    );
    expect((await trace(traceId))[0]).toMatchObject({
      root_span_id: rootId,
      span_count: 4,
    });
  });

  it("rolls up route and method spans per minute with a latency histogram", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const service = `rollup-${hex(3)}`;
    const minuteStart = Math.floor(now / 60_000) * 60_000 - 120_000; // two minutes ago
    const durations = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const spans = durations.map((d, i) =>
      span({
        traceId: hex(16),
        kind: "server",
        startMs: minuteStart + i,
        durationMs: d,
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items",
          "http.response.status_code": i === 9 ? 503 : i === 8 ? 404 : 200,
        },
        status: i === 9 ? { code: "error" } : { code: "unset" },
      }),
    );
    // A server span without a route counts as unmatched; a client span not at all.
    spans.push(
      span({
        traceId: hex(16),
        kind: "server",
        startMs: minuteStart,
        durationMs: 1,
        attributes: { "http.request.method": "GET" },
      }),
      span({
        traceId: hex(16),
        kind: "client",
        startMs: minuteStart,
        durationMs: 1,
        attributes: { "http.request.method": "GET" },
      }),
    );
    const methodTrace = hex(16);
    for (let i = 0; i < 4; i++) {
      spans.push(
        span({
          traceId: methodTrace,
          startMs: minuteStart + i,
          durationMs: 3,
          attributes: {
            "nestrix.class": "ItemsRepository",
            "nestrix.method": "findAll",
            "nestrix.component": "repository",
          },
          status: i === 0 ? { code: "error" } : { code: "unset" },
        }),
      );
    }
    // Split over two writes so the upsert path (adding to an existing row) runs too.
    await sink.write(batch(service, spans.slice(0, 5)));
    await sink.write(batch(service, spans.slice(5)));

    const { rows: routes } = await db.pool.query(
      "SELECT * FROM route_minutes WHERE service_name = $1 ORDER BY route",
      [service],
    );
    expect(routes.map((r) => [r.route, r.count])).toEqual([
      ["(unmatched)", 1],
      ["/items", 10],
    ]);
    const items = routes[1];
    expect(items.minute.getTime()).toBe(minuteStart);
    expect(items.errors).toBe(1); // the 503; the 404 is not an error
    expect(items.max_ms).toBe(1000);
    expect(items.total_ms).toBeCloseTo(durations.reduce((a, b) => a + b, 0));
    expect(items.hist).toHaveLength(30);
    const expected = new Array(30).fill(0);
    for (const d of durations) expected[bucketIndex(d)]++;
    expect(items.hist).toEqual(expected);
    // Percentile estimates from the stored histogram land in the right bucket.
    const p50 = estimateQuantile(items.hist, items.count, 0.5, items.max_ms);
    // Within the bucket that holds the true median (20 ms).
    const b20 = bucketIndex(20);
    expect(p50).toBeGreaterThan(HISTOGRAM_UPPER_BOUNDS_MS[b20 - 1] as number);
    expect(p50).toBeLessThanOrEqual(
      (HISTOGRAM_UPPER_BOUNDS_MS[b20] as number) + 0.001,
    ); // rounded to µs
    expect(
      estimateQuantile(items.hist, items.count, 0.99, items.max_ms),
    ).toBeLessThanOrEqual(1000);

    const { rows: classes } = await db.pool.query(
      "SELECT * FROM class_minutes WHERE service_name = $1",
      [service],
    );
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({
      class_name: "ItemsRepository",
      method_name: "findAll",
      class_kind: "repository",
      count: 4,
      errors: 1,
      max_ms: 3,
    });
    expect(classes[0].total_ms).toBeCloseTo(12);
  });

  it("stores strings Postgres would reject (NUL, lone surrogates) instead of failing the batch", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const traceId = hex(16);
    await sink.write(
      batch("bad\u0000name", [
        span({
          traceId,
          name: "a\u0000b\ud800c",
          startMs: now,
          durationMs: 1,
          attributes: { "k\u0000": "v\udc00", list: ["x\u0000"] },
        }),
      ]),
    );
    const { rows } = await db.pool.query(
      "SELECT name, service_name, attributes FROM spans WHERE trace_id = $1",
      [traceId],
    );
    expect(rows[0]).toEqual({
      name: "a�b�c",
      service_name: "bad�name",
      attributes: { "k�": "v�", list: ["x�"] },
    });
  });

  it("answers IngestBusyError with retryAfterSeconds when the queue is full", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions, {
      maxQueueSpans: 10,
      retryAfterSeconds: 7,
    });
    const mk = (n: number) =>
      batch(
        "busy",
        Array.from({ length: n }, () =>
          span({ traceId: hex(16), startMs: now, durationMs: 1 }),
        ),
      );
    const first = sink.write(mk(6)); // in flight
    const second = sink.write(mk(4)); // queued: 10 of 10
    const third = sink.write(mk(1)); // over
    await expect(third).rejects.toBeInstanceOf(IngestBusyError);
    await expect(third).rejects.toMatchObject({ retryAfterSeconds: 7 });
    await Promise.all([first, second]);
    await sink.whenIdle();
    expect(sink.stats()).toMatchObject({ busyRejections: 1, queuedSpans: 0 });
    // Drained: accepted again, and a batch larger than the whole queue is accepted when it is empty.
    await expect(sink.write(mk(25))).resolves.toBeUndefined();
  });

  it("concurrent batches (two writers, shared traces and routes) are all stored and counted exactly", async () => {
    const a = new PostgresIngestSink(db.pool, partitions, {
      maxSpansPerTransaction: 50,
    });
    const b = new PostgresIngestSink(db.pool, partitions, {
      maxSpansPerTransaction: 50,
    });
    const service = `conc-${hex(3)}`;
    const traceIds = Array.from({ length: 20 }, () => hex(16));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) {
      const spans = traceIds.map((traceId) =>
        span({
          traceId,
          kind: "server",
          startMs: now,
          durationMs: 2,
          parentSpanId: hex(8),
          attributes: { "http.request.method": "GET", "http.route": "/c" },
        }),
      );
      writes.push((i % 2 === 0 ? a : b).write(batch(service, spans)));
    }
    await Promise.all(writes);
    const { rows: counts } = await db.pool.query(
      `SELECT (SELECT count(*)::int FROM spans WHERE service_name = $1) AS spans,
              (SELECT count(*)::int FROM traces WHERE trace_id = ANY($2)) AS traces,
              (SELECT sum(span_count)::int FROM traces WHERE trace_id = ANY($2)) AS span_count,
              (SELECT sum(count)::int FROM route_minutes WHERE service_name = $1) AS route_count`,
      [service, traceIds],
    );
    expect(counts[0]).toEqual({
      spans: 1200,
      traces: 20,
      span_count: 1200,
      route_count: 1200,
    });
    expect(a.stats().transactions + b.stats().transactions).toBeLessThan(60); // group commit
  });

  it("a batch that fails for a non-transient reason fails alone; the others in its group are stored", async () => {
    const errors: string[] = [];
    const sink = new PostgresIngestSink(db.pool, partitions, {
      onError: (_e, context) => errors.push(context),
    });
    const good1 = hex(16);
    const good2 = hex(16);
    const first = sink.write(
      batch("group", [span({ traceId: good1, startMs: now, durationMs: 1 })]),
    );
    // Queued while the first is in flight, so they share one transaction.
    const good = sink.write(
      batch("group", [span({ traceId: good2, startMs: now, durationMs: 1 })]),
    );
    const badSpan = span({ traceId: hex(16), startMs: now, durationMs: 1 });
    (badSpan as { kind: string }).kind = "bogus"; // violates the kind CHECK constraint
    const bad = sink.write(batch("group", [badSpan]));
    await first;
    await expect(good).resolves.toBeUndefined();
    await expect(bad).rejects.toThrow(/check constraint/);
    expect(await trace(good2)).toHaveLength(1);
    expect(sink.stats().failedBatches).toBe(1);
    expect(errors).toContain("writer.batch");
  });

  it("a database that cannot be reached answers IngestBusyError (exporters retry), and the writer keeps working", async () => {
    const dead = new pg.Pool({
      connectionString: "postgres://postgres@127.0.0.1:1/none",
      connectionTimeoutMillis: 2000,
    });
    dead.on("error", () => undefined);
    const errors: unknown[] = [];
    const sink = new PostgresIngestSink(dead, partitions, {
      onError: (e) => errors.push(e),
    });
    const result = sink.write(
      batch("dead", [span({ traceId: hex(16), startMs: now, durationMs: 1 })]),
    );
    await expect(result).rejects.toBeInstanceOf(IngestBusyError);
    expect(errors.length).toBe(1);
    // The loop is not wedged: the next write is attempted (and fails the same way).
    await expect(
      sink.write(
        batch("dead", [
          span({ traceId: hex(16), startMs: now, durationMs: 1 }),
        ]),
      ),
    ).rejects.toBeInstanceOf(IngestBusyError);
    await dead.end();
  });

  it("a throwing onError callback does not break the writer", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions, {
      onError: () => {
        throw new Error("logger down");
      },
    });
    const badSpan = span({ traceId: hex(16), startMs: now, durationMs: 1 });
    (badSpan as { kind: string }).kind = "bogus";
    await expect(sink.write(batch("x", [badSpan]))).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      sink.write(
        batch("x", [span({ traceId: hex(16), startMs: now, durationMs: 1 })]),
      ),
    ).resolves.toBeUndefined();
  });

  it("close() drains what is queued, then refuses new batches as busy", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const pending = [1, 2, 3].map(() =>
      sink.write(
        batch("close", [
          span({ traceId: hex(16), startMs: now, durationMs: 1 }),
        ]),
      ),
    );
    await sink.close(5000);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    await expect(
      sink.write(
        batch("close", [
          span({ traceId: hex(16), startMs: now, durationMs: 1 }),
        ]),
      ),
    ).rejects.toBeInstanceOf(IngestBusyError);
  });
});
