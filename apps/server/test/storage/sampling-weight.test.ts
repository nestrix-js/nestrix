// Issue #30 (D-100): the route rollup weights a server span by the keep probability Nestrix
// writes on it (`nestrix.sampling.probability`), so counts, error rates, SLOs and alert rules
// computed from `route_minutes` stand for every request, not only the sampled ones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METRICS } from "../../src/alerts/metrics.js";
import {
  ATTR_SAMPLING_PROBABILITY,
  samplingWeightOf,
} from "../../src/storage/derive.js";
import { runMigrations } from "../../src/storage/migrate.js";
import { PartitionManager } from "../../src/storage/partitions.js";
import { PostgresIngestSink, wholeWeight } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "./helpers.js";

describe("samplingWeightOf and wholeWeight", () => {
  it("is 1 / p for a probability in (0, 1], and 1 for anything else", () => {
    expect(samplingWeightOf({ [ATTR_SAMPLING_PROBABILITY]: 0.1 })).toBe(10);
    expect(samplingWeightOf({ [ATTR_SAMPLING_PROBABILITY]: 1 })).toBe(1);
    expect(samplingWeightOf({ [ATTR_SAMPLING_PROBABILITY]: 0.25 })).toBe(4);
    for (const bad of [0, -0.5, 1.5, Number.NaN, "0.1", true, [0.1]]) {
      expect(
        samplingWeightOf({
          [ATTR_SAMPLING_PROBABILITY]: bad as unknown as number,
        }),
      ).toBe(1);
    }
    expect(samplingWeightOf({})).toBe(1);
    // Clamped: one span never stands for more than a million requests.
    expect(samplingWeightOf({ [ATTR_SAMPLING_PROBABILITY]: 1e-12 })).toBe(1e6);
  });

  it("rounds a weight to a whole number without bias", () => {
    expect(wholeWeight(10)).toBe(10);
    expect(wholeWeight(1)).toBe(1);
    expect(wholeWeight(Number.NaN)).toBe(1);
    expect(wholeWeight(3.25, () => 0.2)).toBe(4);
    expect(wholeWeight(3.25, () => 0.3)).toBe(3);
    // A seeded generator: the mean of many draws is the weight.
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += wholeWeight(1 / 0.3, random);
    expect(sum / 20_000).toBeCloseTo(1 / 0.3, 1);
  });
});

describe.skipIf(noDatabase)(`weighted route rollup ${skipReason}`, () => {
  let db: TestDb;
  let partitions: PartitionManager;
  const now = Date.now();

  beforeAll(async () => {
    db = await createTestDb("sampling_weight");
    await runMigrations(db.pool);
    partitions = new PartitionManager(db.pool, { retentionDays: 7 });
    await partitions.start();
    partitions.stop();
  });
  afterAll(async () => {
    await db?.drop();
  });

  const server = (
    startMs: number,
    probability: number | undefined,
    status = 200,
  ) =>
    span({
      traceId: hex(16),
      kind: "server",
      startMs,
      durationMs: 5,
      attributes: {
        "http.request.method": "GET",
        "http.route": "/items",
        "http.response.status_code": status,
        ...(probability === undefined
          ? {}
          : { [ATTR_SAMPLING_PROBABILITY]: probability }),
      },
      status: status >= 500 ? { code: "error" } : { code: "unset" },
    });

  it("1,000 requests at sampleRate 0.1 (with every failure kept) count about 1,000, and an alert with minRequests 10 evaluates", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const service = `weighted-${hex(3)}`;
    const minute = Math.floor(now / 60_000) * 60_000 - 60_000;
    // What the app exports for 1,000 requests, 20 of them 5xx: every failure (probability 1) and
    // the ratio's 10% of the 980 others (98 here, probability 0.1).
    const spans = [];
    for (let i = 0; i < 98; i++) spans.push(server(minute + i, 0.1));
    for (let i = 0; i < 20; i++) spans.push(server(minute + i, 1, 503));
    await sink.write(batch(service, spans.slice(0, 50)));
    await sink.write(batch(service, spans.slice(50)));

    const { rows } = await db.pool.query(
      "SELECT count, errors, hist FROM route_minutes WHERE service_name = $1",
      [service],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1_000);
    expect(rows[0].errors).toBe(20);
    expect((rows[0].hist as number[]).reduce((a, b) => a + b, 0)).toBe(1_000);

    const rule = {
      serviceName: service,
      environment: null,
      route: null,
      windowMinutes: 10,
      minRequests: 10,
    };
    expect(await METRICS.error_rate(db.pool, rule, now)).toBeCloseTo(0.02);
  });

  it("an unweighted span counts once, so a host sampler's few spans stay below minRequests", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const service = `unweighted-${hex(3)}`;
    const minute = Math.floor(now / 60_000) * 60_000 - 60_000;
    const spans = [];
    for (let i = 0; i < 5; i++) spans.push(server(minute + i, undefined));
    await sink.write(batch(service, spans));
    const { rows } = await db.pool.query(
      "SELECT count FROM route_minutes WHERE service_name = $1",
      [service],
    );
    expect(rows[0].count).toBe(5);
    expect(
      await METRICS.error_rate(
        db.pool,
        {
          serviceName: service,
          environment: null,
          route: null,
          windowMinutes: 10,
          minRequests: 10,
        },
        now,
      ),
    ).toBeNull();
  });

  // Merged with #28 (D-101): the weight lands in the environment's own rollup row.
  it("weights the rollup row of the span's environment, and an environment rule reads it", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const service = `weighted-env-${hex(3)}`;
    const minute = Math.floor(now / 60_000) * 60_000 - 60_000;
    await sink.write(
      batch(
        service,
        Array.from({ length: 5 }, (_, i) => server(minute + i, 0.25)),
        { "deployment.environment.name": "production" },
      ),
    );
    await sink.write(batch(service, [server(minute, 0.5, 503)]));
    const { rows } = await db.pool.query(
      "SELECT environment, count, errors FROM route_minutes WHERE service_name = $1 ORDER BY environment NULLS FIRST",
      [service],
    );
    expect(rows).toEqual([
      { environment: null, count: 2, errors: 2 },
      { environment: "production", count: 20, errors: 0 },
    ]);
    const rule = {
      serviceName: service,
      route: null,
      windowMinutes: 10,
      minRequests: 10,
    };
    expect(
      await METRICS.error_rate(
        db.pool,
        { ...rule, environment: "production" },
        now,
      ),
    ).toBe(0);
    // `unset` holds 2 weighted requests: below minRequests.
    expect(
      await METRICS.error_rate(db.pool, { ...rule, environment: "unset" }, now),
    ).toBeNull();
    expect(
      await METRICS.error_rate(db.pool, { ...rule, environment: null }, now),
    ).toBeCloseTo(2 / 22);
  });

  it("class rollups are not weighted", async () => {
    const sink = new PostgresIngestSink(db.pool, partitions);
    const service = `classes-${hex(3)}`;
    const minute = Math.floor(now / 60_000) * 60_000 - 60_000;
    await sink.write(
      batch(service, [
        span({
          traceId: hex(16),
          startMs: minute,
          durationMs: 2,
          attributes: {
            "nestrix.class": "ItemsService",
            "nestrix.method": "list",
            [ATTR_SAMPLING_PROBABILITY]: 0.1,
          },
        }),
      ]),
    );
    const { rows } = await db.pool.query(
      "SELECT count FROM class_minutes WHERE service_name = $1",
      [service],
    );
    expect(rows[0].count).toBe(1);
  });
});
