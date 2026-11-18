/**
 * The error-group sync counts each occurrence once (audit, D-103). Runs read overlapping ranges
 * of span start times; an occurrence is counted by the run whose chunk holds its occurrence time,
 * or, when its span started before the next run's read, by the run that reads it last. Regression:
 * a span that started before a run's end and failed after it was counted on that run and again
 * on the next one, in the group and in the release.
 */
import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { ERROR_SYNC_OPTIONS, ErrorGroupSync } from "../../src/errors/sync.js";
import { QueryService } from "../../src/query/query.service.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { testConfig } from "../ingest/helpers.js";
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
/** A run's end, ten minutes ago on a second. */
const T = Math.floor((Date.now() - 10 * MIN) / 1000) * 1000;
const OVERLAP = 30_000;

describe.skipIf(noDatabase)(`error group sync counts ${skipReason}`, () => {
  let db: TestDb;
  let app: NestExpressApplication;
  let clock = 0;
  let sync: ErrorGroupSync;

  beforeAll(async () => {
    db = await createTestDb("synccount");
    const config = testConfig({ DATABASE_URL: db.url });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    })
      .overrideProvider(ERROR_SYNC_OPTIONS)
      .useValue({ schedule: false })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    await app.init();
    sync = new ErrorGroupSync(db.pool, app.get(QueryService), {
      schedule: false,
      lagMs: 0,
      overlapMs: OVERLAP,
      backfillMs: 30 * MIN,
      now: () => clock,
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE error_groups, error_group_releases, error_group_sync CASCADE",
    );
  });

  /** A failing root span from `startMs` to `endMs`, its exception at the end. */
  async function fail(route: string, startMs: number, endMs: number) {
    await app.get(PostgresIngestSink).write(
      batch(
        "shop",
        [
          span({
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
                timeUnixNano: BigInt(endMs) * 1_000_000n,
                attributes: {
                  "exception.type": "Error",
                  "exception.message": `${route} failed`,
                },
              },
            ],
          }),
        ],
        { "service.version": "1.0.0" },
      ),
    );
  }

  async function counts(route: string) {
    const g = await db.pool.query<{ occurrences: string }>(
      "SELECT occurrences::text FROM error_groups WHERE route = $1",
      [route],
    );
    const r = await db.pool.query<{ occurrences: string }>(
      `SELECT r.occurrences::text FROM error_group_releases r
         JOIN error_groups g USING (service_name, environment, key_hash)
        WHERE g.route = $1 AND r.release = '1.0.0'`,
      [route],
    );
    return {
      group: g.rows.map((x) => Number(x.occurrences)),
      release: r.rows.map((x) => Number(x.occurrences)),
    };
  }

  it("counts a span that crosses a run's end once, on the next run (it is read again)", async () => {
    // Starts 10 s before the first run's end, fails 9 s after it: inside the overlap.
    await fail("/cross", T - 10_000, T + 9_000);
    clock = T;
    await sync.runOnce();
    clock = T + MIN;
    await sync.runOnce();
    expect(await counts("/cross")).toEqual({ group: [1], release: [1] });
  });

  it("counts a span that started before the next run's read once, on the run that read it", async () => {
    // Starts 50 s before the first run's end (beyond the 30 s overlap), fails 9 s after it.
    await fail("/long", T - 50_000, T + 9_000);
    clock = T;
    await sync.runOnce();
    expect((await counts("/long")).group).toEqual([1]);
    clock = T + MIN;
    await sync.runOnce();
    expect(await counts("/long")).toEqual({ group: [1], release: [1] });
  });

  it("still counts an ordinary occurrence once across overlapping runs", async () => {
    await fail("/plain", T - 5_000, T - 4_000);
    clock = T;
    await sync.runOnce();
    clock = T + MIN;
    await sync.runOnce();
    clock = T + 2 * MIN;
    await sync.runOnce();
    expect(await counts("/plain")).toEqual({ group: [1], release: [1] });
  });
});
