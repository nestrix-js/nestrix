import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { count } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestSink } from "../../src/ingest/model.js";
import { spans } from "../../src/storage/schema.js";
import {
  resolveStorageOptions,
  STORAGE_DB,
  STORAGE_POOL,
  type StorageDb,
  StorageModule,
} from "../../src/storage/storage.module.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "./helpers.js";

const SINK = Symbol("INGEST_SINK");

describe("storage options", () => {
  it("validates DATABASE_URL and NESTRIX_RETENTION_DAYS", () => {
    expect(() => resolveStorageOptions({}, {})).toThrow(
      /DATABASE_URL is not set/,
    );
    expect(() =>
      resolveStorageOptions(
        {},
        { DATABASE_URL: "postgres://x", NESTRIX_RETENTION_DAYS: "0" },
      ),
    ).toThrow(/NESTRIX_RETENTION_DAYS/);
    expect(() =>
      resolveStorageOptions(
        {},
        { DATABASE_URL: "postgres://x", NESTRIX_RETENTION_DAYS: "2.5" },
      ),
    ).toThrow(/NESTRIX_RETENTION_DAYS/);
    expect(
      resolveStorageOptions({}, { DATABASE_URL: "postgres://x" }).retentionDays,
    ).toBe(7);
    expect(
      resolveStorageOptions(
        {},
        { DATABASE_URL: "postgres://x", NESTRIX_RETENTION_DAYS: "30" },
      ).retentionDays,
    ).toBe(30);
  });
});

describe.skipIf(noDatabase)(`StorageModule ${skipReason}`, () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("module");
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("migrates at start, provides the sink under the receiver's token and a Drizzle handle, and closes the pool", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({ databaseUrl: db.url, sinkToken: SINK }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const sink = app.get<IngestSink>(SINK);
    expect(sink).toBeInstanceOf(PostgresIngestSink);
    expect(sink).toBe(app.get(PostgresIngestSink));
    const traceId = hex(16);
    await sink.write(
      batch("module", [span({ traceId, startMs: Date.now(), durationMs: 1 })]),
    );

    const orm = app.get<StorageDb>(STORAGE_DB);
    const [row] = await orm.select({ n: count() }).from(spans);
    expect(row?.n).toBe(1);
    const found = await orm.query.traces.findFirst({
      where: (t, { eq }) => eq(t.traceId, traceId),
    });
    expect(found).toMatchObject({ traceId, spanCount: 1 });

    const pool = app.get<pg.Pool>(STORAGE_POOL);
    await app.close();
    expect(pool.ended).toBe(true);
  });

  it("fails start-up when the database is unreachable", async () => {
    const moduleRef = Test.createTestingModule({
      imports: [
        StorageModule.forRoot({
          databaseUrl: "postgres://postgres@127.0.0.1:1/none",
        }),
      ],
    });
    await expect(moduleRef.compile()).rejects.toThrow();
  });
});
