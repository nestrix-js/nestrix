/**
 * Ingest order on `spans` (D-114) against a real PostgreSQL: the error-group sync and the live
 * `GET errors` cursor follow `spans.ingest_seq`, so a span stored long after it started is
 * counted (and alerted) once and shown by an `after=head` poll. Before, both read by start time
 * and missed it (D-103 (2), D-107 (9)).
 *
 * Ordering: `ingest_seq` comes from a sequence, and two transactions can commit in the other order
 * than they took their values. The writer takes `TRACES_LOCK` before its INSERT and holds it to
 * COMMIT, so a later value cannot commit first. One test constructs the race through the real
 * writer (a transaction holding the lock with the earlier value, the writer's transaction behind
 * it); a negative control runs the same race without the lock and shows the skip it prevents.
 *
 * Rows stored before migration 0023 have no `ingest_seq` (simulated by setting it to NULL): they
 * are older than every head, so a live poll never returns them (the first page and `before` do),
 * and the sync reads them by start time as before, with the old limit for a late one.
 */
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type {
  AlertRuleCreateResponse,
  AlertWebhookPayload,
  ErrorListResponse,
} from "@nestrix-js/protocol";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertEvaluator } from "../../src/alerts/evaluator.js";
import {
  ALERTS_OPTIONS,
  type ResolvedAlertsOptions,
} from "../../src/alerts/tokens.js";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import type { ServerConfig } from "../../src/config.js";
import { SERVER_CONFIG } from "../../src/config.module.js";
import {
  ERROR_SYNC_OPTIONS,
  ErrorGroupSync,
  PARK_MS,
} from "../../src/errors/sync.js";
import { QueryService } from "../../src/query/query.service.js";
import { ADVISORY_CLASS, TRACES_LOCK } from "../../src/storage/locks.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { type Receiver, startReceiver } from "../alerts/helpers.js";
import { ADMIN_PW, SESSION_SECRET, signedCookie } from "../auth/helpers.js";
import { lastServer, testConfig } from "../ingest/helpers.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(noDatabase)(`ingest order (D-114) ${skipReason}`, () => {
  let db: TestDb;
  let app: NestExpressApplication;
  let baseUrl: string;
  let cookie: string;
  let receiver: Receiver;
  let sync: ErrorGroupSync;
  let evaluator: AlertEvaluator;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        origin: baseUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async (query = ""): Promise<ErrorListResponse> =>
    (
      await call("GET", `/api/v1/errors${query}`)
    ).json() as Promise<ErrorListResponse>;
  const payloads = (): AlertWebhookPayload[] =>
    receiver.requests.map((r) => JSON.parse(r.body) as AlertWebhookPayload);

  /** A failing root span: started at `startMs`, its exception at `endMs`. */
  function failing(route: string, startMs: number, endMs = startMs + 5) {
    return span({
      traceId: hex(16),
      name: `GET ${route}`,
      kind: "server",
      startMs,
      durationMs: endMs - startMs,
      attributes: { "http.request.method": "GET", "http.route": route },
      status: { code: "error" },
      events: [
        {
          name: "exception",
          timeUnixNano: BigInt(Math.floor(endMs)) * 1_000_000n,
          attributes: {
            "exception.type": "Error",
            "exception.message": `${route} failed`,
          },
        },
      ],
    });
  }

  async function write(route: string, startMs: number, endMs?: number) {
    const s = failing(route, startMs, endMs);
    await app.get(PostgresIngestSink).write(batch("shop", [s]));
    return s;
  }

  async function seqOf(traceId: string): Promise<string | null> {
    const r = await db.pool.query<{ seq: string | null }>(
      "SELECT ingest_seq::text AS seq FROM spans WHERE trace_id = $1",
      [traceId],
    );
    return r.rows[0]?.seq ?? null;
  }

  async function occurrences(route: string): Promise<number[]> {
    const r = await db.pool.query<{ n: string }>(
      "SELECT occurrences::text AS n FROM error_groups WHERE route = $1",
      [route],
    );
    return r.rows.map((x) => Number(x.n));
  }

  /**
   * A failing span inserted on `client` as the writer would, minus the writer: the same columns
   * the writer derives for a server span with an exception, `ingest_seq` from the default.
   */
  async function rawInsert(
    client: pg.PoolClient,
    route: string,
    startMs: number,
  ): Promise<{ traceId: string; seq: string }> {
    const traceId = hex(16);
    const resource = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM resources ORDER BY id LIMIT 1",
    );
    const startNs = BigInt(startMs) * 1_000_000n;
    const events = [
      {
        name: "exception",
        timeUnixNano: String(startNs + 5_000_000n),
        attributes: {
          "exception.type": "Error",
          "exception.message": `${route} failed`,
        },
      },
    ];
    const res = await client.query<{ seq: string }>(
      `INSERT INTO spans (trace_id, span_id, resource_id, service_name, name, kind, start_time,
                          start_ns, end_ns, duration_ns, status_code, attributes, events, links,
                          http_route, http_method, is_root, is_error, trace_type, is_occurrence,
                          error_key)
       VALUES ($1, $2, $3, 'shop', $4, 'server', $5, $6, $7, 5000000, 'error', $8, $9, '[]',
               $10, 'GET', true, true, 'http', true, $11)
       RETURNING ingest_seq::text AS seq`,
      [
        traceId,
        hex(8),
        resource.rows[0]?.id,
        `GET ${route}`,
        new Date(startMs),
        String(startNs),
        String(startNs + 5_000_000n),
        JSON.stringify({ "http.route": route, "http.request.method": "GET" }),
        JSON.stringify(events),
        route,
        hex(16),
      ],
    );
    return { traceId, seq: res.rows[0]?.seq as string };
  }

  beforeAll(async () => {
    db = await createTestDb("ingestorder");
    receiver = await startReceiver();
    const config = testConfig({
      DATABASE_URL: db.url,
      NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
      NESTRIX_SESSION_SECRET: SESSION_SECRET,
      NESTRIX_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1",
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    })
      .overrideProvider(ALERTS_OPTIONS)
      .useFactory({
        inject: [SERVER_CONFIG],
        factory: (c: ServerConfig): ResolvedAlertsOptions => ({
          schedule: false,
          webhook: { backoffMs: () => 10, timeoutMs: 1000 },
          publicUrl: c.alerts.publicUrl,
          allowedHosts: c.alerts.allowedHosts,
          retentionDays: c.retentionDays,
        }),
      })
      .overrideProvider(ERROR_SYNC_OPTIONS)
      .useValue({ schedule: false, lagMs: 0 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, config);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    lastServer.port = port;
    baseUrl = `http://127.0.0.1:${port}`;
    cookie = signedCookie(undefined, undefined, undefined, port);
    sync = app.get(ErrorGroupSync);
    evaluator = app.get(AlertEvaluator);
    // A first stored span: the writer creates today's partition and a resource row.
    await write("/seed", Date.now() - 2 * MIN);
  });

  afterAll(async () => {
    app?.getHttpServer().closeAllConnections();
    await app?.close();
    await receiver?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE error_groups, error_group_releases, error_group_sync, error_group_alerts CASCADE",
    );
  });

  it("every writer's INSERT gets an ingest_seq from the default, in insert order", async () => {
    const a = await write("/order-a", Date.now() - 10 * MIN);
    const b = await write("/order-b", Date.now() - 20 * MIN);
    const sa = await seqOf(a.traceId);
    const sb = await seqOf(b.traceId);
    expect(sa).not.toBeNull();
    expect(BigInt(sb as string)).toBeGreaterThan(BigInt(sa as string));
  });

  it("counts a span stored long after it started once, and alerts once (D-103 (2) fixed)", async () => {
    const res = await call("POST", "/api/v1/alerts", {
      name: "new groups",
      metric: "new_error_group",
      webhookUrl: receiver.url,
    });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as AlertRuleCreateResponse;
    await sleep(50);
    receiver.requests.length = 0;
    // The sync runs and its watermarks move past now.
    await sync.runOnce();
    await sync.runOnce();
    // A job that started 30 minutes ago and failed 29 minutes ago, stored now: its start is far
    // behind the start-time watermark plus the 2 minute overlap.
    const now = Date.now();
    await write("/late-job", now - 30 * MIN, now - 29 * MIN);
    const run = await sync.runOnce();
    expect(run.counted).toBe(1);
    expect(await occurrences("/late-job")).toEqual([1]);
    for (let i = 0; i < 3; i++) {
      await sync.runOnce();
      const e = await evaluator.runOnce();
      await Promise.all(e.deliveries);
    }
    expect(await occurrences("/late-job")).toEqual([1]);
    const late = payloads().filter((p) => p.route === "/late-job");
    expect(late.map((p) => p.errorGroup?.reason)).toEqual(["new"]);
    await call("DELETE", `/api/v1/alerts/${rule.rule.id}`);
  });

  it("a live after=head poll shows an error stored after a newer-started one (D-107 (9) fixed)", async () => {
    await write("/newest", Date.now() - 1_000);
    const first = await list();
    expect(first.head).toMatch(/^es[0-9a-z]+$/);
    expect(first.items[0]?.route).toBe("/newest");
    // Stored now, started an hour ago: by start it sorts far below the head.
    await write("/older-started", Date.now() - 60 * MIN);
    const poll = await list(`?after=${first.head}`);
    expect(poll.reset).toBe(false);
    expect(poll.items.map((i) => i.route)).toEqual(["/older-started"]);
    expect(poll.head).not.toBe(first.head);
    const again = await list(`?after=${poll.head}`);
    expect(again.items).toEqual([]);
    // A position cursor (a held head from before D-114) still reads by start, as it did.
    const byPosition = await list(`?after=${first.items[0]?.cursor}`);
    expect(byPosition.items.map((i) => i.route)).toEqual([]);
    expect(byPosition.head).toBe(poll.head);
  });

  it("more errors after the head than one page: reset with the first page itself", async () => {
    const { head } = await list();
    await write("/burst-1", Date.now() - 50 * MIN);
    await write("/burst-2", Date.now() - 40 * MIN);
    await write("/burst-3", Date.now() - 500);
    const poll = await list(`?limit=2&after=${head}`);
    expect(poll.reset).toBe(true);
    const firstPage = await list("?limit=2");
    expect(poll.items).toEqual(firstPage.items);
    expect(poll.head).toBe(firstPage.head);
  });

  it("two writers committing out of order never cause a skip: the later value waits for the lock", async () => {
    const { head } = await list();
    await sync.runOnce();
    // Transaction A takes the lock as the writer does and inserts: it holds the earlier value.
    const a = await db.pool.connect();
    let bDone = false;
    let bWrite: Promise<unknown> | undefined;
    let b: ReturnType<typeof failing> | undefined;
    try {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1, $2)", [
        ADVISORY_CLASS,
        TRACES_LOCK,
      ]);
      const inA = await rawInsert(a, "/race-a", Date.now() - 45 * MIN);
      // Writer B (the real sink) starts now and would commit first if nothing stopped it.
      b = failing("/race-b", Date.now() - 100);
      bWrite = app
        .get(PostgresIngestSink)
        .write(batch("shop", [b]))
        .then(() => {
          bDone = true;
        });
      await sleep(400);
      expect(bDone).toBe(false);
      expect(await seqOf(b.traceId)).toBeNull();
      // A poll and a sync while A is open see neither.
      const during = await list(`?after=${head}`);
      expect(during.items.map((i) => i.route)).toEqual([]);
      expect((await sync.runOnce()).counted).toBe(0);
      await a.query("COMMIT");
      await bWrite;
      const sb = await seqOf(b.traceId);
      expect(BigInt(sb as string)).toBeGreaterThan(BigInt(inA.seq));
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release();
      await bWrite?.catch(() => undefined);
    }
    const poll = await list(`?after=${head}`);
    expect(poll.items.map((i) => i.route).sort()).toEqual([
      "/race-a",
      "/race-b",
    ]);
    await sync.runOnce();
    await sync.runOnce();
    expect(await occurrences("/race-a")).toEqual([1]);
    expect(await occurrences("/race-b")).toEqual([1]);
  });

  it("negative control: without the lock, a later value committing first is skipped", async () => {
    // Shows what the lock prevents: two raw transactions, neither takes TRACES_LOCK.
    await sync.runOnce();
    const { head } = await list();
    const a = await db.pool.connect();
    const b = await db.pool.connect();
    let polled: ErrorListResponse | undefined;
    let inA: { seq: string } | undefined;
    try {
      await a.query("BEGIN");
      inA = await rawInsert(a, "/nolock-a", Date.now() - 45 * MIN);
      await b.query("BEGIN");
      const inB = await rawInsert(b, "/nolock-b", Date.now() - 100);
      expect(BigInt(inB.seq)).toBeGreaterThan(BigInt(inA.seq));
      await b.query("COMMIT");
      // The reader sees B (the later value) and moves past it; the sync does too.
      polled = await list(`?after=${head}`);
      expect(polled.items.map((i) => i.route)).toEqual(["/nolock-b"]);
      expect((await sync.runOnce()).counted).toBe(1);
      await a.query("COMMIT");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
    const next = await list(`?after=${polled?.head}`);
    expect(next.items.map((i) => i.route)).toEqual([]);
    await sync.runOnce();
    expect(await occurrences("/nolock-a")).toEqual([]);
  });

  it("the switch takes the previous release's watermark, parks it ahead, and counts nothing twice", async () => {
    // State as the previous release leaves it: its watermark 5 minutes back, no seq columns.
    const now = Date.now();
    await db.pool.query(
      "INSERT INTO error_group_sync (id, watermark) VALUES (1, $1)",
      [new Date(now - 5 * MIN)],
    );
    // Stored before the switch: one inside the previous watermark's overlap window (counted by
    // the start-time read), one long before it and so already counted by the previous release.
    await write("/before-switch", now - 3 * MIN);
    await write("/counted-earlier", now - 40 * MIN);
    await sync.runOnce();
    const state = await db.pool.query<{
      watermark: Date;
      seq_watermark: string;
      legacy_seq: string;
      legacy_watermark: Date;
    }>(
      "SELECT watermark, seq_watermark::text, legacy_seq::text, legacy_watermark FROM error_group_sync",
    );
    const row = state.rows[0];
    expect(row?.seq_watermark).toBe(row?.legacy_seq);
    expect(row?.watermark.getTime()).toBeGreaterThanOrEqual(
      now + PARK_MS - MIN,
    );
    expect(row?.legacy_watermark.getTime()).toBeGreaterThan(now - MIN);
    expect(await occurrences("/before-switch")).toEqual([1]);
    expect(await occurrences("/counted-earlier")).toEqual([]);
    // After the switch, everything is in ingest order; later runs count nothing again.
    await write("/after-switch", now - 50 * MIN);
    await sync.runOnce();
    await sync.runOnce();
    expect(await occurrences("/before-switch")).toEqual([1]);
    expect(await occurrences("/after-switch")).toEqual([1]);
  });

  it("a first run that commits the switch and then dies leaves the previous watermark parked", async () => {
    // The previous release's state; a lock released by a dying run must not let a replica of that
    // release read from an un-parked watermark and count what the switch hands to this release.
    const now = Date.now();
    await db.pool.query(
      "INSERT INTO error_group_sync (id, watermark) VALUES (1, $1)",
      [new Date(now - 5 * MIN)],
    );
    await write("/before-switch", now - 3 * MIN);
    const errors: string[] = [];
    const real = app.get(QueryService);
    const faulty = new ErrorGroupSync(
      db.pool,
      {
        errorOccurrences: () => Promise.reject(new Error("injected legacy")),
        errorOccurrencesBySeq: real.errorOccurrencesBySeq.bind(real),
      },
      { schedule: false, lagMs: 0, onError: (m) => errors.push(m) },
    );
    const run = await faulty.runOnce();
    expect(run.counted).toBe(0);
    expect(errors.join()).toContain("injected legacy");
    const state = await db.pool.query<{
      watermark: Date;
      seq_watermark: string | null;
    }>("SELECT watermark, seq_watermark::text FROM error_group_sync");
    // The switch is committed (it is what the dying run did) ...
    expect(state.rows[0]?.seq_watermark).not.toBeNull();
    // ... and so is the park: an old-release sync reads `start_time > watermark` while the
    // watermark is behind its clock, and finds the loop's condition false.
    expect(state.rows[0]?.watermark.getTime()).toBeGreaterThanOrEqual(
      now + PARK_MS - MIN,
    );
    expect(await occurrences("/before-switch")).toEqual([]);
  });

  it("rows stored before migration 0023 (NULL ingest_seq): first page yes, live poll never; the sync reads them by start", async () => {
    const recent = await write("/pre-recent", Date.now() - 1 * MIN);
    const lateOld = await write("/pre-late", Date.now() - 50 * MIN);
    await db.pool.query(
      "UPDATE spans SET ingest_seq = NULL WHERE trace_id = ANY($1)",
      [[recent.traceId, lateOld.traceId]],
    );
    // A previous watermark 4 minutes back: the start-time read covers /pre-recent, not /pre-late.
    await db.pool.query(
      "INSERT INTO error_group_sync (id, watermark) VALUES (1, $1)",
      [new Date(Date.now() - 4 * MIN)],
    );
    const page = await list("?limit=100");
    const routes = page.items.map((i) => i.route);
    expect(routes).toContain("/pre-recent");
    expect(routes).toContain("/pre-late");
    // The head is the newest sequenced error; NULL rows are older than every head.
    const poll = await list("?limit=200&after=es0");
    expect(poll.reset).toBe(false);
    expect(poll.items.length).toBeGreaterThan(0);
    expect(poll.items.map((i) => i.route)).not.toContain("/pre-recent");
    expect(poll.items.map((i) => i.route)).not.toContain("/pre-late");
    await sync.runOnce();
    await sync.runOnce();
    expect(await occurrences("/pre-recent")).toEqual([1]);
    // The documented limit, kept for rows stored before this release: a late one is not read.
    expect(await occurrences("/pre-late")).toEqual([]);
  });

  it("a failing ingest-order read reports, counts nothing and moves no watermark (no loss)", async () => {
    await sync.runOnce();
    const before = await db.pool.query<{ seq: string }>(
      "SELECT seq_watermark::text AS seq FROM error_group_sync",
    );
    await write("/fault", Date.now() - 20 * MIN);
    const errors: string[] = [];
    const real = app.get(QueryService);
    const faulty = new ErrorGroupSync(
      db.pool,
      {
        errorOccurrences: real.errorOccurrences.bind(real),
        errorOccurrencesBySeq: () => Promise.reject(new Error("injected")),
      },
      { schedule: false, lagMs: 0, onError: (m) => errors.push(m) },
    );
    const run = await faulty.runOnce();
    expect(run.counted).toBe(0);
    expect(errors.join()).toContain("injected");
    const after = await db.pool.query<{ seq: string }>(
      "SELECT seq_watermark::text AS seq FROM error_group_sync",
    );
    expect(after.rows[0]?.seq).toBe(before.rows[0]?.seq);
    // The failed run discarded its connection; its session lock goes when that backend exits.
    for (let i = 0; i < 50; i++) {
      if ((await sync.runOnce()).skipped !== "locked") break;
      await sleep(20);
    }
    expect(await occurrences("/fault")).toEqual([1]);
  });
});
