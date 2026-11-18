// POST /v1/metrics (issue #18, D-105): off by default (404 as before), and with NESTRIX_METRICS=on
// the receiver's checks, the catalog (what is stored, what is counted and dropped), partial success
// for invalid points, and malformed or oversized bodies. Untrusted input: Vitest fails the run on
// any unhandled error, so "never crashes" is checked throughout.
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeMetricsRequest } from "../../src/ingest/decode.js";
import { toIngestMetricBatch } from "../../src/ingest/map-metrics.js";
import {
  auth,
  JSON_TYPE,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();
const START = (BigInt(Date.now() - 60_000) * 1_000_000n).toString();

const attr = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

function metricsJson(metrics: unknown[], instance = "i-1") {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr("service.name", "svc"),
            attr("service.instance.id", instance),
          ],
        },
        scopeMetrics: [{ scope: { name: "@nestrix-js/nestjs" }, metrics }],
      },
    ],
  };
}

const cpu = (over: Record<string, unknown> = {}) => ({
  name: "process.cpu.time",
  unit: "s",
  sum: {
    isMonotonic: true,
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: START,
        timeUnixNano: nowNs(),
        asDouble: 12.5,
        attributes: [attr("cpu.mode", "user"), attr("process.pid", "1")],
      },
      {
        startTimeUnixNano: START,
        timeUnixNano: nowNs(),
        asDouble: 2.5,
        attributes: [attr("cpu.mode", "system")],
      },
    ],
    ...over,
  },
});

const rss = (value: unknown = 1000) => ({
  name: "process.memory.usage",
  unit: "By",
  gauge: { dataPoints: [{ timeUnixNano: nowNs(), asInt: value }] },
});

const duration = (bounds: number[], counts: string[]) => ({
  name: "http.server.request.duration",
  unit: "s",
  histogram: {
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: START,
        timeUnixNano: nowNs(),
        count: counts.reduce((a, b) => a + Number(b), 0).toString(),
        sum: 1.5,
        explicitBounds: bounds,
        bucketCounts: counts,
      },
    ],
  },
});

describe("POST /v1/metrics off (default)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => server.close());

  it("answers 404 and stores nothing", async () => {
    const res = await post(
      `${server.baseUrl}/v1/metrics`,
      JSON.stringify(metricsJson([rss()])),
      {
        "content-type": JSON_TYPE,
        ...auth(),
      },
    );
    expect(res.status).toBe(404);
    expect(server.sink.metricBatches).toHaveLength(0);
  });
});

describe("POST /v1/metrics on", () => {
  let server: TestServer;
  const url = () => `${server.baseUrl}/v1/metrics`;
  const send = (body: unknown, headers: Record<string, string> = auth()) =>
    post(url(), typeof body === "string" ? body : JSON.stringify(body), {
      "content-type": JSON_TYPE,
      ...headers,
    });
  beforeAll(async () => {
    server = await startServer(testConfig({ NESTRIX_METRICS: "on" }));
  });
  afterAll(async () => server.close());

  it("needs the ingest key", async () => {
    expect((await send(metricsJson([rss()]), {})).status).toBe(401);
    expect(server.sink.metricBatches).toHaveLength(0);
  });

  it("stores catalog metrics, keeping only the catalog's attributes", async () => {
    const res = await send(
      metricsJson([cpu(), rss(), duration([0.1, 1], ["3", "2", "1"])]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const batch = server.sink.metricBatches.at(-1);
    expect(batch?.resourceMetrics[0]).toMatchObject({
      serviceName: "svc",
      instanceId: "i-1",
    });
    const points = server.sink.metricPoints();
    const user = points.find(
      (p) =>
        p.metric === "process.cpu.time" && p.attributes["cpu.mode"] === "user",
    );
    expect(user).toMatchObject({
      kind: "counter",
      temporality: "cumulative",
      value: 12.5,
    });
    expect(Object.keys(user?.attributes ?? {})).toEqual(["cpu.mode"]);
    expect(
      points.find((p) => p.metric === "process.memory.usage"),
    ).toMatchObject({ kind: "gauge", value: 1000 });
    expect(points.find((p) => p.kind === "histogram")).toMatchObject({
      bounds: [0.1, 1],
      bucketCounts: [3, 2, 1],
    });
  });

  it("counts and drops what the catalog does not store, without an error", async () => {
    const before = server.sink.metricPoints().length;
    const res = await send(
      metricsJson([
        {
          name: "my.custom",
          unit: "1",
          gauge: { dataPoints: [{ timeUnixNano: nowNs(), asInt: 1 }] },
        },
        {
          name: "process.memory.usage",
          unit: "s",
          gauge: { dataPoints: [{ timeUnixNano: nowNs(), asInt: 1 }] },
        },
        {
          name: "process.cpu.time",
          unit: "s",
          summary: {
            dataPoints: [{ timeUnixNano: nowNs(), count: "1", sum: 1 }],
          },
        },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess?: { rejectedDataPoints?: unknown; errorMessage?: string };
    };
    // A warning only: nothing was rejected, so the exporter does not retry or count failures.
    expect(Number(body.partialSuccess?.rejectedDataPoints ?? 0)).toBe(0);
    expect(body.partialSuccess?.errorMessage).toMatch(/does not store/);
    expect(server.sink.metricPoints()).toHaveLength(before);
    const dropped = server.sink.metricBatches.at(-1)?.dropped;
    expect(dropped).toMatchObject({
      notStored: 1,
      typeMismatch: 1,
      unsupportedType: 1,
    });
  });

  it("answers partial success for invalid points and keeps the valid ones", async () => {
    const res = await send(
      metricsJson([
        {
          name: "process.memory.usage",
          unit: "By",
          gauge: {
            dataPoints: [
              { timeUnixNano: nowNs(), asInt: 5 },
              { timeUnixNano: nowNs(), asDouble: "NaN" },
              { asInt: 3 },
            ],
          },
        },
        duration([1, 0.5], ["1", "1", "1"]),
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess?: {
        rejectedDataPoints?: string | number;
        errorMessage?: string;
      };
    };
    expect(Number(body.partialSuccess?.rejectedDataPoints)).toBe(3);
    expect(body.partialSuccess?.errorMessage).toMatch(/Rejected 3/);
    expect(server.sink.metricPoints().some((p) => p.value === 5)).toBe(true);
  });

  it("rejects malformed bodies with 400 and a body over the point limit with 413", async () => {
    expect((await send("{not json")).status).toBe(400);
    expect((await send("[]")).status).toBe(400);
    expect((await send(JSON.stringify({ resourceMetrics: "x" }))).status).toBe(
      400,
    );
    const gz = await post(url(), gzipSync("garbage"), {
      "content-type": JSON_TYPE,
      "content-encoding": "gzip",
      ...auth(),
    });
    expect(gz.status).toBe(400);
    const over = testConfig({ NESTRIX_METRICS: "on" }).ingest.maxSpans + 1;
    const points = Array.from({ length: over }, () => ({
      timeUnixNano: nowNs(),
      asInt: 1,
    }));
    const big = await send(
      metricsJson([
        {
          name: "process.memory.usage",
          unit: "By",
          gauge: { dataPoints: points },
        },
      ]),
    );
    expect(big.status).toBe(413);
  });

  it("rejects a histogram with too many bounds as a bad point, not a crash", async () => {
    const bounds = Array.from({ length: 300 }, (_, i) => i + 1);
    const res = await send(
      metricsJson([
        duration(
          bounds,
          Array.from({ length: 301 }, () => "1"),
        ),
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess?: { rejectedDataPoints?: string | number };
    };
    expect(Number(body.partialSuccess?.rejectedDataPoints)).toBe(1);
  });
});

describe("toIngestMetricBatch", () => {
  const limits = {
    maxSpans: 1000,
    maxMessages: 100_000,
    maxJsonTokens: 100_000,
    maxDepth: 32,
  };
  const map = (json: unknown) =>
    toIngestMetricBatch(
      decodeMetricsRequest(Buffer.from(JSON.stringify(json)), "json", limits),
    );

  it("merges points that differ only in a dropped attribute (counter sums, level max)", () => {
    const batch = map(
      metricsJson([
        {
          name: "nodejs.eventloop.delay.max",
          unit: "s",
          gauge: {
            dataPoints: [
              {
                timeUnixNano: "1700000000000000000",
                asDouble: 0.1,
                attributes: [attr("a", "1")],
              },
              {
                timeUnixNano: "1700000000000000000",
                asDouble: 0.3,
                attributes: [attr("a", "2")],
              },
            ],
          },
        },
      ]),
    );
    expect(batch.resourceMetrics[0]?.points).toHaveLength(1);
    expect(batch.resourceMetrics[0]?.points[0]?.value).toBe(0.3);
  });

  it("does not let a __proto__ attribute reach Object.prototype", () => {
    map(
      metricsJson([
        {
          name: "process.cpu.time",
          unit: "s",
          sum: {
            isMonotonic: true,
            aggregationTemporality: 2,
            dataPoints: [
              {
                startTimeUnixNano: "1",
                timeUnixNano: "1700000000000000000",
                asDouble: 1,
                attributes: [attr("__proto__", "x"), attr("cpu.mode", "user")],
              },
            ],
          },
        },
      ]),
    );
    expect(({} as Record<string, unknown>).cpu).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe("metrics config and limits", () => {
  it("NESTRIX_METRICS accepts on or off only; the caps are bounded", () => {
    expect(testConfig().metrics.enabled).toBe(false);
    expect(testConfig({ NESTRIX_METRICS: "ON" }).metrics.enabled).toBe(true);
    expect(() => testConfig({ NESTRIX_METRICS: "yes" })).toThrow(
      /NESTRIX_METRICS/,
    );
    expect(() =>
      testConfig({ NESTRIX_METRICS_MAX_SERIES_PER_SERVICE: "1" }),
    ).toThrow(/MAX_SERIES_PER_SERVICE/);
  });

  it("SeriesLimiter admits known series and frees the ones not seen within the window", async () => {
    const { SeriesLimiter } = await import("../../src/storage/metrics.js");
    const l = new SeriesLimiter(2, 3, 1000);
    expect(l.admit("s", "a", 0)).toBe(true);
    expect(l.admit("s", "b", 0)).toBe(true);
    expect(l.admit("s", "c", 0)).toBe(false);
    expect(l.admit("s", "a", 5)).toBe(true);
    // Over the total across services.
    expect(l.admit("t", "x", 0)).toBe(true);
    expect(l.admit("u", "y", 0)).toBe(false);
    // Later, the old series have expired.
    expect(l.admit("s", "c", 20_000)).toBe(true);
    expect(l.active).toBeLessThanOrEqual(3);
  });

  it("histogramQuantile interpolates inside the bucket and caps at the last bound", async () => {
    const { histogramQuantile } = await import(
      "../../src/query/metrics.service.js"
    );
    expect(histogramQuantile([1, 2], [0, 0, 0], 0.5)).toBeNull();
    expect(histogramQuantile([1, 2], [10, 0, 0], 0.5)).toBeCloseTo(0.5, 9);
    expect(histogramQuantile([1, 2], [0, 10, 0], 0.5)).toBeCloseTo(1.5, 9);
    expect(histogramQuantile([1, 2], [0, 0, 10], 0.99)).toBe(2);
  });
});
