/**
 * Issue #87 (D-118), end to end against PostgreSQL: with NESTRIX_METRICS=all an application's own
 * OTLP metrics are stored in `metric_minutes` with their unit and attributes, listed by
 * `GET /api/v1/metrics/catalog` and served by `/series` with attribute filters and `by=attr.<key>`;
 * the name and series caps bound them. With `on` none of this exists.
 */
import "reflect-metadata";
import type {
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
const BASE = Math.floor((Date.now() - 60 * MIN) / MIN) * MIN;
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

/** A cumulative counter with one point per `channel` value. */
const orders = (t: number, values: Record<string, number>) => ({
  name: "orders.created",
  unit: "{order}",
  sum: {
    isMonotonic: true,
    aggregationTemporality: 2,
    dataPoints: Object.entries(values).map(([channel, v]) => ({
      startTimeUnixNano: ns(BASE - MIN),
      timeUnixNano: ns(t),
      asInt: String(v),
      attributes: [attr("channel", channel)],
    })),
  },
});

const depth = (t: number, values: Record<string, number>) => ({
  name: "queue.depth",
  unit: "{job}",
  gauge: {
    dataPoints: Object.entries(values).map(([queue, v]) => ({
      timeUnixNano: ns(t),
      asDouble: v,
      attributes: [attr("queue", queue)],
    })),
  },
});

const wait = (t: number, i: number) => ({
  name: "db.client.connection.wait_time",
  unit: "s",
  histogram: {
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: ns(BASE - MIN),
        timeUnixNano: ns(t),
        count: String(i * 10),
        explicitBounds: [0.01, 0.1],
        bucketCounts: [String(i * 8), String(i * 2), "0"],
      },
    ],
  },
});

const gauge = (name: string, t: number, attributes: unknown[] = []) => ({
  name,
  unit: "1",
  gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: 1, attributes }] },
});

const sendTo = (server: QueryServer, body: unknown) =>
  post(`${server.baseUrl}/v1/metrics`, JSON.stringify(body), {
    "content-type": JSON_TYPE,
    ...auth(),
  });

describe.skipIf(noDatabase)(`application metrics ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  const range = `fromUnixMs=${BASE}&toUnixMs=${BASE + 20 * MIN}`;
  const series = (q: string) =>
    server.json<MetricSeriesResponse>(
      `/api/v1/metrics/series?${range}&stepMs=60000&${q}`,
    );

  beforeAll(async () => {
    db = await createTestDb("appmetrics");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "all",
    });
    // 20 minutes, two instances. orders.created: web +60 and api +30 a minute on each (1/s and
    // 0.5/s). queue.depth on a only: mail 10, export 4. The wait-time histogram on a: per minute 8
    // waits <= 10 ms and 2 in (10 ms, 100 ms].
    for (let i = 0; i < 20; i++) {
      const t = BASE + i * MIN + 5_000;
      for (const instance of ["a", "b"]) {
        const metrics: unknown[] = [orders(t, { web: i * 60, api: i * 30 })];
        if (instance === "a") {
          metrics.push(depth(t, { mail: 10, export: 4 }), wait(t, i));
          // A runtime metric beside them keeps its catalog handling.
          metrics.push({
            name: "process.memory.usage",
            unit: "By",
            gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: 100 }] },
          });
        }
        const res = await sendTo(server, resource(instance, metrics));
        expect(res.status).toBe(200);
      }
    }
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("stores the unit on application rows only", async () => {
    const rows = await db.pool.query<{
      metric_name: string;
      unit: string | null;
    }>("SELECT DISTINCT metric_name, unit FROM metric_minutes ORDER BY 1");
    expect(rows.rows).toEqual([
      { metric_name: "db.client.connection.wait_time", unit: "s" },
      { metric_name: "orders.created", unit: "{order}" },
      { metric_name: "process.memory.usage", unit: null },
      { metric_name: "queue.depth", unit: "{job}" },
    ]);
  });

  it("the catalog lists application metrics after the runtime ones, with type, unit and attribute keys", async () => {
    const c = await server.json<MetricCatalogResponse>(
      `/api/v1/metrics/catalog?${range}`,
    );
    const app = c.metrics.filter((m) => m.app);
    expect(app.map((m) => m.name)).toEqual([
      "db.client.connection.wait_time",
      "orders.created",
      "queue.depth",
    ]);
    expect(app[1]).toMatchObject({
      kind: "counter",
      unit: "{order}",
      valueUnit: "{order}/s",
      defaultAggregation: "sum",
      attributeKeys: ["channel"],
    });
    expect(app[2]).toMatchObject({ kind: "gauge", attributeKeys: ["queue"] });
    expect(c.metrics[0]?.app).toBeUndefined();
    expect(c.appMetricsTruncated).toBe(false);
    expect(c.ingest).toMatchObject({
      overNameCap: 0,
      droppedAttributes: 0,
      maxNamesPerService: 200,
    });
  });

  it("a counter is a rate summed over series and instances; by=attr.<key> splits it", async () => {
    const all = await series("metric=orders.created&service=shop");
    expect(all.valueUnit).toBe("{order}/s");
    expect(all.series[0]?.values[5]).toBeCloseTo(3, 6);
    const by = await series("metric=orders.created&by=attr.channel");
    expect(by.by).toBe("attr.channel");
    expect(by.groupCount).toBe(2);
    const web = by.series.find((s) => s.group === "web");
    const api = by.series.find((s) => s.group === "api");
    expect(web?.label).toBe("web");
    expect(web?.values[5]).toBeCloseTo(2, 6);
    expect(api?.values[5]).toBeCloseTo(1, 6);
    const one = await series(
      "metric=orders.created&attr.channel=api&instance=b",
    );
    expect(one.series[0]?.values[5]).toBeCloseTo(0.5, 6);
  });

  it("a gauge adds an instance's series; a filter or a group keeps them apart", async () => {
    const total = await series("metric=queue.depth");
    expect(total.series[0]?.values[5]).toBeCloseTo(14, 6);
    const mail = await series("metric=queue.depth&attr.queue=mail");
    expect(mail.series[0]?.values[5]).toBeCloseTo(10, 6);
    const by = await series("metric=queue.depth&by=attr.queue");
    expect(
      Object.fromEntries(by.series.map((s) => [s.group, s.values[5]])),
    ).toEqual({ mail: 10, export: 4 });
    // A key no series has is one group, `(none)`.
    const none = await series("metric=queue.depth&by=attr.region");
    expect(none.series.map((s) => s.label)).toEqual(["(none)"]);
  });

  it("a histogram gives p50/p95/p99 in its unit", async () => {
    const s = await series("metric=db.client.connection.wait_time");
    expect(s.unit).toBe("s");
    expect(s.series.map((x) => x.label)).toEqual(["p50", "p95", "p99"]);
    expect(s.series[0]?.values[10]).toBeCloseTo(0.00625, 6);
  });

  it("answers 400 for what it cannot serve", async () => {
    for (const q of [
      "metric=unknown.metric",
      "metric=db.client.connection.wait_time&by=attr.pool",
      "metric=orders.created&by=attr.1bad",
      "metric=orders.created&by=queue",
      "metric=orders.created&attr.1bad=x",
      `metric=orders.created&attr.channel=${"x".repeat(257)}`,
      "metric=orders.created&attr.a=1&attr.b=1&attr.c=1&attr.d=1&attr.e=1",
    ]) {
      const res = await server.get(`/api/v1/metrics/series?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});

describe.skipIf(noDatabase)(`application metric bounds ${skipReason}`, () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("appmetricscap");
  });
  afterAll(async () => db?.drop());

  it("drops and counts names over NESTRIX_METRICS_MAX_NAMES_PER_SERVICE; catalog names do not count", async () => {
    const server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "all",
      NESTRIX_METRICS_MAX_NAMES_PER_SERVICE: "2",
    });
    try {
      const t = Date.now() - 5_000;
      const res = await sendTo(
        server,
        resource(
          "a",
          [
            gauge("first.metric", t),
            gauge("second.metric", t),
            gauge("third.metric", t),
            {
              name: "process.memory.usage",
              unit: "By",
              gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: 1 }] },
            },
          ],
          "named",
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        partialSuccess?: { errorMessage?: string };
      };
      expect(body.partialSuccess?.errorMessage).toMatch(
        /1 data points were dropped: the service is over its metric name limit/,
      );
      // Another service has its own allowance.
      expect(
        (
          await sendTo(
            server,
            resource("a", [gauge("third.metric", t)], "other"),
          )
        ).status,
      ).toBe(200);
      const c = await server.json<MetricCatalogResponse>(
        "/api/v1/metrics/catalog",
      );
      expect(c.ingest.overNameCap).toBe(1);
      expect(c.ingest.maxNamesPerService).toBe(2);
      expect(c.metrics.filter((m) => m.app).map((m) => m.name)).toEqual([
        "first.metric",
        "second.metric",
        "third.metric",
      ]);
      const rows = await db.pool.query(
        "SELECT 1 FROM metric_minutes WHERE service_name = 'named' AND metric_name = 'third.metric'",
      );
      expect(rows.rowCount).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("counts attribute sets against the series cap", async () => {
    const server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "all",
      NESTRIX_METRICS_MAX_SERIES_PER_SERVICE: "10",
    });
    try {
      const t = Date.now() - 5_000;
      const points = Array.from({ length: 12 }, (_, i) =>
        gauge("tenant.storage", t, [attr("tenant", `t${i}`)]),
      );
      const res = await sendTo(server, resource("a", points, "series"));
      expect(res.status).toBe(200);
      const c = await server.json<MetricCatalogResponse>(
        "/api/v1/metrics/catalog?service=series",
      );
      expect(c.ingest.overSeriesCap).toBe(2);
      expect(c.ingest.activeSeries).toBe(10);
    } finally {
      await server.close();
    }
  });

  it("with NESTRIX_METRICS=on an application metric is dropped and the new parameters do not exist", async () => {
    const server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "on",
    });
    try {
      const t = Date.now() - 5_000;
      const res = await sendTo(
        server,
        resource("a", [gauge("only.on", t)], "onsvc"),
      );
      const body = (await res.json()) as {
        partialSuccess?: { errorMessage?: string };
      };
      expect(body.partialSuccess?.errorMessage).toMatch(
        /does not store were dropped/,
      );
      const c = await server.json<MetricCatalogResponse>(
        "/api/v1/metrics/catalog",
      );
      expect(c.metrics.some((m) => m.app)).toBe(false);
      expect("overNameCap" in c.ingest).toBe(false);
      expect("appMetricsTruncated" in c).toBe(false);
      for (const q of [
        "metric=first.metric",
        "metric=process.cpu.time&by=attr.cpu.mode",
        "metric=process.cpu.time&attr.cpu.mode=user",
      ]) {
        const r = await server.get(`/api/v1/metrics/series?${q}`);
        expect(r.status, q).toBe(400);
      }
    } finally {
      await server.close();
    }
  });
});
