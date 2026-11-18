/**
 * Live cursors (audit): `GET traces` and `GET errors` read the page and its `head` from one
 * snapshot, so a row committed while a list is being read is either on the page or after the
 * head, and the next `after=head` poll returns it. Regression: the page and the head were two
 * concurrent pool queries; a row committed between their snapshots was covered by the head but
 * missing from the page, and no later poll asked for it.
 *
 * The seam: the service's pool is wrapped so its statements run one after another and a matching
 * trace with an error is committed right after the first one finishes.
 */
import "reflect-metadata";
import type {
  ErrorListResponse,
  TraceListResponse,
} from "@nestrix-js/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryService } from "../../src/query/query.service.js";
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

const failing = (route: string, startMs: number) =>
  span({
    traceId: hex(16),
    name: `GET ${route}`,
    kind: "server",
    startMs,
    durationMs: 5,
    attributes: { "http.request.method": "GET", "http.route": route },
    status: { code: "error" },
    events: [
      {
        name: "exception",
        timeUnixNano: BigInt(startMs + 1) * 1_000_000n,
        attributes: { "exception.type": "Error", "exception.message": route },
      },
    ],
  });

describe.skipIf(noDatabase)(`live cursors ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let service: QueryService;
  let realPool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDb("livecursor");
    server = await startQueryServer(db.url);
    service = server.app.get(QueryService);
    realPool = (service as unknown as { pool: pg.Pool }).pool;
    await write("/first", Date.now() - 60_000);
  });
  afterAll(async () => {
    (service as unknown as { pool: pg.Pool }).pool = realPool;
    await server?.close();
    await db?.drop();
  });

  async function write(route: string, startMs: number): Promise<void> {
    await server.app
      .get(PostgresIngestSink)
      .write(batch("shop", [failing(route, startMs)]));
  }

  /** Runs `read` with a commit of a new failing trace right after its first statement. */
  async function withCommitBetween<T>(
    route: string,
    startMs: number,
    read: () => Promise<T>,
  ): Promise<T> {
    let chain: Promise<unknown> = Promise.resolve();
    let first = true;
    const wrapper = {
      query: (text: string, params?: unknown[]) => {
        const run = chain.then(async () => {
          const result = await realPool.query(text, params);
          if (first) {
            first = false;
            await write(route, startMs);
          }
          return result;
        });
        chain = run.catch(() => undefined);
        return run;
      },
    };
    (service as unknown as { pool: unknown }).pool = wrapper;
    try {
      return await read();
    } finally {
      (service as unknown as { pool: pg.Pool }).pool = realPool;
    }
  }

  it("traces: a trace committed during the read is returned by the next poll", async () => {
    const start = await service.listTraces({ limit: 50 });
    const page = await withCommitBetween(
      "/during-traces",
      Date.now() - 1000,
      () => service.listTraces({ limit: 50, after: start.head ?? undefined }),
    );
    const next = await service.listTraces({
      limit: 50,
      after: page.head ?? undefined,
    });
    const seen = [...page.items, ...next.items].map((t) => t.route);
    expect(seen).toContain("/during-traces");
  });

  it("errors: an error committed during the read is returned by the next poll", async () => {
    const start = await service.listErrors({ limit: 50 });
    const page = await withCommitBetween(
      "/during-errors",
      Date.now() - 500,
      () => service.listErrors({ limit: 50, after: start.head ?? undefined }),
    );
    const next = await service.listErrors({
      limit: 50,
      after: page.head ?? undefined,
    });
    const seen = [...page.items, ...next.items].map((e) => e.route);
    expect(seen).toContain("/during-errors");
  });

  it("an empty store answers an empty page with a null head, in one read", async () => {
    await db.pool.query("TRUNCATE spans, traces");
    const traces: TraceListResponse = await service.listTraces({ limit: 10 });
    const errors: ErrorListResponse = await service.listErrors({ limit: 10 });
    expect(traces).toMatchObject({ items: [], head: null, older: null });
    expect(errors).toMatchObject({ items: [], head: null, older: null });
  });
});
