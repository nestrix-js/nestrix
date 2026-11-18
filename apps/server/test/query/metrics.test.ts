/**
 * Issue #18 (D-105), end to end against PostgreSQL: OTLP metrics posted to `/v1/metrics` (receiver,
 * writer) land in the day-partitioned `metric_minutes` table and are served by
 * `GET /api/v1/metrics/catalog` and `/series`: counter rates (restarts, gaps), gauges, histogram
 * quantiles, aggregation across instances, the series cap and the 404 / 400 answers.
 */
import "reflect-metadata";
import type {
  MetaResponse,
  MetricCatalogResponse,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, JSON_TYPE, post } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const MIN = 60_000;
/** Minute-aligned, 90 minutes ago: data for the last 40 minutes before the range's end. */
const BASE = Math.floor((Date.now() - 90 * MIN) / MIN) * MIN;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const attr = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

function resource(instance: string, metrics: unknown[], service = "shop") {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr("service.name", service),
            attr("service.instance.id", instance),
          ],
        },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
}

const cpu = (t: number, user: number, start: number, system?: number) => ({
  name: "process.cpu.time",
  unit: "s",
  sum: {
    isMonotonic: true,
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: ns(start),
        timeUnixNano: ns(t),
        asDouble: user,
        attributes: [attr("cpu.mode", "user")],
      },
      ...(system === undefined
        ? []
        : [
            {
              startTimeUnixNano: ns(start),
              timeUnixNano: ns(t),
              asDouble: system,
              attributes: [attr("cpu.mode", "system")],
            },
          ]),
    ],
  },
});

const gauge = (name: string, t: number, value: number, unit = "By") => ({
  name,
  unit,
  gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: value }] },
});

const histogram = (t: number, start: number, counts: number[]) => ({
  name: "http.server.request.duration",
  unit: "s",
  histogram: {
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: ns(start),
        timeUnixNano: ns(t),
        count: String(counts.reduce((a, b) => a + b, 0)),
        sum: 1,
        explicitBounds: [0.1, 1],
        bucketCounts: counts.map(String),
      },
    ],
  },
});

describe.skipIf(noDatabase)(`metrics ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  const send = (body: unknown) =>
    post(`${server.baseUrl}/v1/metrics`, JSON.stringify(body), {
      "content-type": JSON_TYPE,
      ...auth(),
    });
  const series = (q: string) =>
    server.json<MetricSeriesResponse>(
      `/api/v1/metrics/series?fromUnixMs=${BASE}&toUnixMs=${BASE + 40 * MIN}&stepMs=60000&${q}`,
    );

  beforeAll(async () => {
    db = await createTestDb("metrics");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "on",
    });
    // 40 minutes. Instance a: 0.5 cpu-s/s user + 0.1 system, restarts at minute 20 (the counter
    // starts again from 3 s). Instance b: 0.25 cpu-s/s, silent from minute 10 to 30 (a gap).
    for (let i = 0; i < 40; i++) {
      const t = BASE + i * MIN + 5_000;
      const restart = i >= 20;
      const startA = restart ? BASE + 20 * MIN : BASE - MIN;
      const since = restart ? i - 20 : i;
      expect(
        (
          await send(
            resource("a", [
              cpu(
                t,
                restart ? 3 + since * 30 : i * 30,
                startA,
                restart ? 1 + since * 6 : i * 6,
              ),
              gauge("process.memory.usage", t, 100 + i),
              gauge("nodejs.eventloop.delay.max", t, i === 7 ? 0.5 : 0.01, "s"),
              histogram(t, BASE - MIN, [i * 8, i * 2, i * 0]),
            ]),
          )
        ).status,
      ).toBe(200);
      if (i < 10 || i >= 30) {
        expect(
          (
            await send(
              resource("b", [
                cpu(t, i * 15, BASE - MIN),
                gauge("process.memory.usage", t, 300),
              ]),
            )
          ).status,
        ).toBe(200);
      }
    }
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("meta says metrics are available", async () => {
    const meta = await server.json<MetaResponse>("/api/v1/meta");
    expect(meta.metrics).toEqual({ available: true });
  });

  it("the catalog lists the stored metrics, services, instances and what the receiver kept", async () => {
    const c = await server.json<MetricCatalogResponse>(
      `/api/v1/metrics/catalog?fromUnixMs=${BASE}&toUnixMs=${BASE + 40 * MIN}`,
    );
    expect(c.minStepMs).toBe(MIN);
    expect(c.metrics.map((m) => m.name)).toContain("process.cpu.time");
    expect(c.metrics.find((m) => m.name === "process.cpu.time")).toMatchObject({
      kind: "counter",
      valueUnit: "s/s",
      defaultAggregation: "sum",
    });
    expect(c.services).toContain("shop");
    expect(c.instances.map((i) => i.instanceId).sort()).toEqual(["a", "b"]);
    expect(c.ingest.storedPoints).toBeGreaterThan(100);
    expect(c.ingest.maxSeriesPerService).toBe(2000);
  });

  it("a counter is a rate per second, modes and instances added", async () => {
    const s = await series("metric=process.cpu.time&service=shop");
    expect(s.valueUnit).toBe("s/s");
    expect(s.timestamps).toHaveLength(40);
    const values = s.series[0]?.values ?? [];
    // Minute 5: a 0.5 + 0.1, b 0.25.
    expect(values[5]).toBeCloseTo(0.85, 6);
    // Minute 15, b is silent: a only.
    expect(values[15]).toBeCloseTo(0.6, 6);
    // The restart (minute 20): a's new value since the restart (3 + 1 s over 60 s), not negative.
    expect(values[20]).toBeCloseTo(4 / 60, 6);
    expect(values.every((v) => v === null || v >= 0)).toBe(true);
    expect(s.instances).toEqual(["a", "b"]);
  });

  it("a gap is null, never zero or interpolated (the first row after silence has no usable predecessor)", async () => {
    const b = await series("metric=process.cpu.time&service=shop&instance=b");
    const values = b.series[0]?.values ?? [];
    expect(values[5]).toBeCloseTo(0.25, 6);
    expect(values.slice(11, 30).every((v) => v === null)).toBe(true);
    expect(values[30]).toBeNull();
    expect(values[31]).toBeCloseTo(0.25, 6);
  });

  it("by=instance gives one series per instance; aggregation=max the busiest", async () => {
    const by = await series("metric=process.cpu.time&service=shop&by=instance");
    expect(by.series.map((x) => x.instanceId).sort()).toEqual(["a", "b"]);
    const a = by.series.find((x) => x.instanceId === "a");
    expect(a?.values[5]).toBeCloseTo(0.6, 6);
    const max = await series("metric=process.cpu.time&aggregation=max");
    expect(max.aggregation).toBe("max");
    expect(max.series[0]?.values[5]).toBeCloseTo(0.6, 6);
  });

  it("a gauge is the mean per instance, averaged across instances; max and min follow the aggregation", async () => {
    const avg = await series("metric=process.memory.usage");
    expect(avg.aggregation).toBe("avg");
    expect(avg.valueUnit).toBe("By");
    expect(avg.series[0]?.values[5]).toBeCloseTo((105 + 300) / 2, 6);
    expect(avg.series[0]?.values[15]).toBeCloseTo(115, 6);
    const sum = await series("metric=process.memory.usage&aggregation=sum");
    expect(sum.series[0]?.values[5]).toBeCloseTo(405, 6);
    const peak = await series(
      "metric=nodejs.eventloop.delay.max&aggregation=max",
    );
    expect(peak.series[0]?.values[7]).toBeCloseTo(0.5, 6);
    expect(peak.series[0]?.values[8]).toBeCloseTo(0.01, 6);
  });

  it("buckets coarser than a minute average gauges over their minutes", async () => {
    const q = `metric=process.memory.usage&instance=a&fromUnixMs=${BASE}&toUnixMs=${BASE + 40 * MIN}`;
    const fine = await server.json<MetricSeriesResponse>(
      `/api/v1/metrics/series?${q}&stepMs=60000`,
    );
    const coarse = await server.json<MetricSeriesResponse>(
      `/api/v1/metrics/series?${q}&stepMs=600000`,
    );
    expect(coarse.stepMs).toBe(10 * MIN);
    // The second 10-minute bucket: the mean of the minutes that fall inside it.
    const start = coarse.timestamps[1] as number;
    const inside = fine.timestamps
      .map((t, k) =>
        t >= start && t < start + 10 * MIN
          ? (fine.series[0]?.values[k] as number)
          : null,
      )
      .filter((v): v is number => v !== null);
    expect(inside).toHaveLength(10);
    expect(coarse.series[0]?.values[1]).toBeCloseTo(
      inside.reduce((x, y) => x + y, 0) / 10,
      6,
    );
  });

  it("a histogram gives quantiles from bucket increases, interpolated inside the bucket", async () => {
    const s = await series("metric=http.server.request.duration&service=shop");
    expect(s.series.map((x) => x.label)).toEqual(["p50", "p95", "p99"]);
    // Per minute 8 requests <= 0.1 s and 2 in (0.1, 1]: p50 is inside the first bucket.
    const p50 = s.series[0]?.values[10] as number;
    const p95 = s.series[1]?.values[10] as number;
    expect(p50).toBeCloseTo(0.0625, 6);
    expect(p95).toBeGreaterThan(0.1);
    expect(p95).toBeLessThanOrEqual(1);
    expect(s.series[0]?.values[0]).toBeNull();
  });

  it("answers 400 for a bad request and names the parameter", async () => {
    for (const q of [
      "",
      "metric=nope",
      "metric=process.cpu.time&stepMs=90000",
      "metric=process.cpu.time&fromUnixMs=0&stepMs=60000",
      "metric=http.server.request.duration&by=instance",
      "metric=process.cpu.time&toUnixMs=1&fromUnixMs=2",
      "metric=process.cpu.time&aggregation=median",
      "metric=process.cpu.time&bogus=1",
    ]) {
      const res = await server.get(`/api/v1/metrics/series?${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it("a delta counter is its per-minute sum over 60 s, and a delta histogram's quantiles come from each minute's own buckets", async () => {
    for (let i = 0; i < 5; i++) {
      const t = BASE + i * MIN + 5_000;
      const res = await send(
        resource(
          "d1",
          [
            {
              name: "process.cpu.time",
              unit: "s",
              sum: {
                isMonotonic: true,
                aggregationTemporality: 1,
                dataPoints: [
                  {
                    startTimeUnixNano: ns(t - MIN),
                    timeUnixNano: ns(t),
                    asDouble: 30,
                    attributes: [attr("cpu.mode", "user")],
                  },
                ],
              },
            },
            {
              name: "http.server.request.duration",
              unit: "s",
              histogram: {
                aggregationTemporality: 1,
                dataPoints: [
                  {
                    startTimeUnixNano: ns(t - MIN),
                    timeUnixNano: ns(t),
                    count: "10",
                    sum: 1,
                    explicitBounds: [0.1, 1],
                    bucketCounts: ["8", "2", "0"],
                  },
                ],
              },
            },
          ],
          "deltasvc",
        ),
      );
      expect(res.status).toBe(200);
    }
    const rate = await series("metric=process.cpu.time&service=deltasvc");
    expect(rate.series[0]?.values[2]).toBeCloseTo(0.5, 6);
    const q = await series(
      "metric=http.server.request.duration&service=deltasvc",
    );
    expect(q.series[0]?.values[2]).toBeCloseTo(0.0625, 6);
    expect(q.series[0]?.values[10]).toBeNull();
  });

  it("drops a point older than two hours and counts it", async () => {
    const before = await server.json<MetricCatalogResponse>(
      `/api/v1/metrics/catalog?fromUnixMs=${BASE}&toUnixMs=${BASE + 40 * MIN}`,
    );
    const res = await send(
      resource(
        "o1",
        [gauge("process.memory.usage", Date.now() - 3 * 3_600_000, 7)],
        "oldsvc",
      ),
    );
    expect(res.status).toBe(200);
    const after = await server.json<MetricCatalogResponse>(
      `/api/v1/metrics/catalog?fromUnixMs=${BASE}&toUnixMs=${BASE + 40 * MIN}`,
    );
    expect(after.ingest.outOfRange).toBe(before.ingest.outOfRange + 1);
    expect(after.services).not.toContain("oldsvc");
  });

  it("sends no CORS headers on either route", async () => {
    for (const path of [
      `/api/v1/metrics/catalog?fromUnixMs=${BASE}&toUnixMs=${BASE + MIN}`,
      `/api/v1/metrics/series?metric=process.cpu.time&fromUnixMs=${BASE}&toUnixMs=${BASE + 10 * MIN}`,
    ]) {
      const res = await server.get(path, { origin: "https://evil.example" });
      expect(res.status, path).toBe(200);
      const cors = [...res.headers.keys()].filter((k) =>
        k.startsWith("access-control-"),
      );
      expect(cors, path).toEqual([]);
    }
  });

  it("is closed to a visitor without a session", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/metrics/catalog`);
    expect([401, 403, 503]).toContain(res.status);
  });
});

describe.skipIf(noDatabase)(`metrics off and capped ${skipReason}`, () => {
  let db: TestDb;
  let off: QueryServer;
  beforeAll(async () => {
    db = await createTestDb("metricsoff");
    off = await startQueryServer(db.url);
  });
  afterAll(async () => {
    await off?.close();
    await db?.drop();
  });

  it("answers 404 on both routes and meta says unavailable when NESTRIX_METRICS is not on", async () => {
    expect((await off.get("/api/v1/metrics/catalog")).status).toBe(404);
    expect(
      (await off.get("/api/v1/metrics/series?metric=process.cpu.time")).status,
    ).toBe(404);
    expect((await off.json<MetaResponse>("/api/v1/meta")).metrics).toEqual({
      available: false,
    });
    const res = await post(`${off.baseUrl}/v1/metrics`, "{}", {
      "content-type": JSON_TYPE,
      ...auth(),
    });
    expect(res.status).toBe(404);
  });

  it("stops storing series over the per-service cap and counts them", async () => {
    const capped = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "on",
      NESTRIX_METRICS_MAX_SERIES_PER_SERVICE: "10",
    });
    try {
      const t = Date.now() - 5_000;
      for (let i = 0; i < 12; i++) {
        const res = await post(
          `${capped.baseUrl}/v1/metrics`,
          JSON.stringify(
            resource(
              `pod-${i}`,
              [gauge("process.memory.usage", t, 1)],
              "capped",
            ),
          ),
          { "content-type": JSON_TYPE, ...auth() },
        );
        expect(res.status).toBe(200);
      }
      const c = await capped.json<MetricCatalogResponse>(
        "/api/v1/metrics/catalog?service=capped",
      );
      expect(c.ingest.overSeriesCap).toBe(2);
      expect(c.ingest.activeSeries).toBe(10);
      expect(c.instances).toHaveLength(10);
    } finally {
      await capped.close();
    }
  });
});
