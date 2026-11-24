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
  PROTO,
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

  it("refuses a packed varint run that would decode far larger than its wire size (413, not decoded)", async () => {
    const varint = (n: number) => {
      const out: number[] = [];
      let v = n;
      while (v > 127) {
        out.push((v & 127) | 128);
        v = Math.floor(v / 128);
      }
      out.push(v);
      return Buffer.from(out);
    };
    const ld = (field: number, payload: Buffer) =>
      Buffer.concat([
        varint((field << 3) | 2),
        varint(payload.length),
        payload,
      ]);
    // ExponentialHistogramDataPoint.positive (8) > Buckets.bucket_counts (2): one wire byte each.
    const buckets = ld(2, Buffer.alloc(12 * 1024 * 1024, 0));
    const eh = ld(1, ld(8, buckets));
    const metric = Buffer.concat([ld(1, Buffer.from("x")), ld(10, eh)]);
    const body = ld(1, ld(2, ld(2, metric)));
    const before = server.sink.metricBatches.length;
    const res = await post(url(), body, { "content-type": PROTO, ...auth() });
    expect(res.status).toBe(413);
    expect(server.sink.metricBatches).toHaveLength(before);
  });

  it("applies the point limit to snake_case JSON too", async () => {
    const over = testConfig({ NESTRIX_METRICS: "on" }).ingest.maxSpans + 1;
    const dataPoints = Array.from({ length: over }, () => ({
      time_unix_nano: nowNs(),
      as_int: 1,
    }));
    const res = await send({
      resource_metrics: [
        {
          resource: { attributes: [attr("service.name", "svc")] },
          scope_metrics: [
            {
              metrics: [
                {
                  name: "process.memory.usage",
                  unit: "By",
                  gauge: { data_points: dataPoints },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(413);
  });

  it("rejects values beyond 1e100 and histograms with unsorted bounds or a bucket count mismatch", async () => {
    const before = server.sink.metricPoints().length;
    const res = await send(
      metricsJson([
        {
          name: "process.memory.usage",
          unit: "By",
          gauge: { dataPoints: [{ timeUnixNano: nowNs(), asDouble: 1e300 }] },
        },
        duration([1, 0.5], ["1", "1", "1"]),
        duration([0.5, 1], ["1", "1"]),
        {
          ...duration([0.5, 1], ["1", "1", "1"]),
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [
              {
                startTimeUnixNano: START,
                timeUnixNano: nowNs(),
                sum: 1e200,
                explicitBounds: [0.5, 1],
                bucketCounts: ["1", "1", "1"],
              },
            ],
          },
        },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess?: {
        rejectedDataPoints?: string | number;
        errorMessage?: string;
      };
    };
    expect(Number(body.partialSuccess?.rejectedDataPoints)).toBe(4);
    expect(body.partialSuccess?.errorMessage).toMatch(
      /value out of range \(2\)/,
    );
    expect(server.sink.metricPoints()).toHaveLength(before);
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

  it("derives a stable instance key from the resource attributes when service.instance.id is absent", () => {
    const body = (host: string) => ({
      resourceMetrics: [
        {
          resource: {
            attributes: [attr("service.name", "svc"), attr("host.name", host)],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "process.cpu.time",
                  unit: "s",
                  sum: {
                    isMonotonic: true,
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        startTimeUnixNano: START,
                        timeUnixNano: nowNs(),
                        asDouble: 1,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const a1 = map(body("a")).resourceMetrics[0]?.instanceId;
    const a2 = map(body("a")).resourceMetrics[0]?.instanceId;
    const b = map(body("b")).resourceMetrics[0]?.instanceId;
    expect(a1).toMatch(/^attrs-[0-9a-f]{12}$/);
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    // An explicit id is used as sent.
    expect(
      map(metricsJson([rss()], "pod-9")).resourceMetrics[0]?.instanceId,
    ).toBe("pod-9");
  });

  it("caps merged sums and cuts a long service name", () => {
    const big = (v: number) => ({
      timeUnixNano: nowNs(),
      asDouble: v,
    });
    const batch = toIngestMetricBatch(
      decodeMetricsRequest(
        Buffer.from(
          JSON.stringify({
            resourceMetrics: [
              {
                resource: {
                  attributes: [attr("service.name", "s".repeat(1000))],
                },
                scopeMetrics: [
                  {
                    metrics: [
                      {
                        name: "process.memory.usage",
                        unit: "By",
                        gauge: { dataPoints: [big(9e99), big(9e99)] },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
        "json",
        limits,
      ),
    );
    expect(batch.resourceMetrics[0]?.serviceName).toHaveLength(256);
    expect(batch.resourceMetrics[0]?.points[0]?.value).toBeLessThanOrEqual(
      1e100,
    );
  });

  it("keeps attribute maps free of a prototype, so a __proto__ key stays an ordinary key", () => {
    const batch = map(
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
    const kept = batch.resourceMetrics[0]?.points[0]?.attributes as object;
    expect(Object.getPrototypeOf(kept)).toBeNull();
    expect(Object.keys(kept)).toEqual(["cpu.mode"]);
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

// Issue #87 (D-118): NESTRIX_METRICS=all stores the application's own metrics within bounds.
describe("application metrics (NESTRIX_METRICS=all)", () => {
  const limits = {
    maxSpans: 1000,
    maxMessages: 100_000,
    maxJsonTokens: 100_000,
    maxDepth: 32,
  };
  const T = "1700000000000000000";
  const S = "1699999940000000000";
  const map = (metrics: unknown[], all = true) =>
    toIngestMetricBatch(
      decodeMetricsRequest(
        Buffer.from(JSON.stringify(metricsJson(metrics))),
        "json",
        limits,
      ),
      1_700_000_000_000_000_000n,
      all,
    );
  const counter = (name: string, unit: string, attributes: unknown[] = []) => ({
    name,
    unit,
    sum: {
      isMonotonic: true,
      aggregationTemporality: 2,
      dataPoints: [
        { startTimeUnixNano: S, timeUnixNano: T, asInt: "7", attributes },
      ],
    },
  });

  it("stores any name with its declared type and unit; on keeps dropping it", () => {
    const metrics = [
      counter("orders.created", "{order}", [attr("channel", "web")]),
      {
        name: "queue.depth",
        unit: "{job}",
        gauge: { dataPoints: [{ timeUnixNano: T, asDouble: 4 }] },
      },
      {
        name: "pool.connections.active",
        unit: "",
        sum: {
          isMonotonic: false,
          aggregationTemporality: 2,
          dataPoints: [{ startTimeUnixNano: S, timeUnixNano: T, asInt: "3" }],
        },
      },
      {
        name: "db.client.connection.wait_time",
        unit: "s",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              startTimeUnixNano: S,
              timeUnixNano: T,
              count: "3",
              explicitBounds: [0.01, 0.1],
              bucketCounts: ["1", "1", "1"],
            },
          ],
        },
      },
      {
        name: "payload.size",
        unit: "By",
        exponentialHistogram: {
          aggregationTemporality: 2,
          dataPoints: [{ timeUnixNano: T, count: "1" }],
        },
      },
    ];
    const batch = map(metrics);
    const points = batch.resourceMetrics[0]?.points ?? [];
    expect(
      points.map((p) => [p.metric, p.kind, p.temporality, p.unit]),
    ).toEqual([
      ["orders.created", "counter", "cumulative", "{order}"],
      ["queue.depth", "gauge", "cumulative", "{job}"],
      ["pool.connections.active", "gauge", "cumulative", ""],
      ["db.client.connection.wait_time", "histogram", "delta", "s"],
    ]);
    expect(points[0]?.attributes).toEqual({ channel: "web" });
    expect(batch.dropped).toMatchObject({ unsupportedType: 1, notStored: 0 });

    const on = map(metrics, false);
    expect(on.resourceMetrics).toHaveLength(0);
    expect(on.dropped).toMatchObject({ notStored: 4, unsupportedType: 1 });
  });

  it("keeps the runtime catalog's checks: a catalog name with another unit is still a type mismatch", () => {
    const batch = map([
      {
        name: "process.memory.usage",
        unit: "MiBy",
        gauge: { dataPoints: [{ timeUnixNano: T, asDouble: 1 }] },
      },
    ]);
    expect(batch.resourceMetrics).toHaveLength(0);
    expect(batch.dropped.typeMismatch).toBe(1);
  });

  it("bounds attributes: 16 keys (sorted), 128-character keys, scalar values, 256-character values", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      attr(`k${String(i).padStart(2, "0")}`, "v"),
    );
    const batch = map([
      counter("orders.created", "{order}", [
        ...many,
        attr("x".repeat(129), "too long a key"),
        { key: "list", value: { arrayValue: { values: [] } } },
        { key: "ok", value: { boolValue: true } },
        { key: "a.n", value: { intValue: "5" } },
        attr("a.long", "y".repeat(300)),
      ]),
    ]);
    const kept = batch.resourceMetrics[0]?.points[0]?.attributes ?? {};
    expect(Object.getPrototypeOf(kept)).toBeNull();
    expect(Object.keys(kept)).toHaveLength(16);
    // Sorted: a.long, a.n, k00..k13; k14..k19 and ok are past the first 16.
    expect(Object.keys(kept)).toContain("k13");
    expect(Object.keys(kept)).not.toContain("k14");
    expect(kept["a.long"]).toHaveLength(256);
    expect(kept["a.n"]).toBe("5");
    // Dropped: the long key, the array, and 23 - 16 = 7 past the limit.
    expect(batch.droppedAttributes).toBe(9);
  });

  it("does not store an empty or overlong name or unit, and counts it", () => {
    const batch = map([
      counter("", "1"),
      counter("n".repeat(256), "1"),
      counter("orders.created", "u".repeat(64)),
      counter("n".repeat(255), "u".repeat(63)),
    ]);
    expect(batch.dropped.notStored).toBe(3);
    expect(batch.resourceMetrics[0]?.points).toHaveLength(1);
  });

  it("keeps one name sent with two units as two points (they become two series)", () => {
    const batch = map([
      counter("orders.created", "1"),
      counter("orders.created", "{order}"),
    ]);
    expect(batch.resourceMetrics[0]?.points.map((p) => p.unit)).toEqual([
      "1",
      "{order}",
    ]);
  });

  it("NESTRIX_METRICS=all and the name cap are configured", () => {
    const all = testConfig({ NESTRIX_METRICS: "all" }).metrics;
    expect(all).toMatchObject({
      enabled: true,
      all: true,
      maxNamesPerService: 200,
    });
    expect(testConfig({ NESTRIX_METRICS: "on" }).metrics.all).toBe(false);
    expect(
      testConfig({ NESTRIX_METRICS_MAX_NAMES_PER_SERVICE: "5" }).metrics
        .maxNamesPerService,
    ).toBe(5);
    expect(() =>
      testConfig({ NESTRIX_METRICS_MAX_NAMES_PER_SERVICE: "0" }),
    ).toThrow(/MAX_NAMES_PER_SERVICE/);
  });

  it("NameLimiter admits known names, refuses new ones over the cap and frees expired ones", async () => {
    const { NameLimiter } = await import("../../src/storage/metrics.js");
    const l = new NameLimiter(2, 1000);
    expect(l.allows("s", "a", 0)).toBe(true);
    l.touch("s", "a", 0);
    l.touch("s", "b", 0);
    expect(l.allows("s", "c", 0)).toBe(false);
    expect(l.allows("s", "a", 0)).toBe(true);
    expect(l.allows("t", "c", 0)).toBe(true);
    expect(l.allows("s", "c", 20_000)).toBe(true);
  });
});

describe("POST /v1/metrics all", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(testConfig({ NESTRIX_METRICS: "all" }));
  });
  afterAll(async () => server.close());

  it("stores an application metric and names dropped attributes in the partial success", async () => {
    const res = await post(
      `${server.baseUrl}/v1/metrics`,
      JSON.stringify(
        metricsJson([
          {
            name: "orders.created",
            unit: "{order}",
            sum: {
              isMonotonic: true,
              aggregationTemporality: 2,
              dataPoints: [
                {
                  startTimeUnixNano: START,
                  timeUnixNano: nowNs(),
                  asInt: "1",
                  attributes: [
                    attr("channel", "web"),
                    { key: "tags", value: { arrayValue: { values: [] } } },
                  ],
                },
              ],
            },
          },
        ]),
      ),
      { "content-type": JSON_TYPE, ...auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess?: { errorMessage?: string; rejectedDataPoints?: string };
    };
    expect(body.partialSuccess?.errorMessage).toMatch(
      /1 attributes were dropped/,
    );
    expect(body.partialSuccess?.rejectedDataPoints ?? "0").toBe("0");
    const point =
      server.sink.metricBatches.at(-1)?.resourceMetrics[0]?.points[0];
    expect(point).toMatchObject({ metric: "orders.created", unit: "{order}" });
  });
});
