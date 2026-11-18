/**
 * Issue #28 (D-101): the same service in several environments is kept apart in storage, in every
 * query that takes `environment`, and in the rollups the alert rules and SLOs read.
 */
import "reflect-metadata";
import type {
  MetaResponse,
  RouteStatsResponse,
  TraceListResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rangeTotals } from "../../src/alerts/metrics.js";
import type { IngestMetricBatch } from "../../src/ingest/model.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { seedMinute } from "../alerts/helpers.js";
import {
  batch,
  createTestDb,
  noDatabase,
  nsAt,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
const MIN = 60_000;
const NOW = Date.now();

const root = (n: number, startMs: number, status: number) =>
  span({
    traceId: tid(n),
    spanId: sid(n),
    name: "GET /x",
    kind: "server",
    startMs,
    durationMs: 20,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/x",
      "http.response.status_code": status,
    },
  });

describe.skipIf(noDatabase)(`environments ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  const t = Math.floor((NOW - 2 * MIN) / MIN) * MIN + 10_000;

  beforeAll(async () => {
    db = await createTestDb("envs");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    // Newest first in the store: unset is the oldest, production the newest.
    await sink.write(batch("shop", [root(1, t, 200)]));
    await sink.write(
      batch("shop", [root(2, t + 1, 500), root(3, t + 2, 200)], {
        "deployment.environment.name": "staging",
      }),
    );
    // The deprecated attribute is read when the current one is absent.
    await sink.write(
      batch(
        "shop",
        [root(4, t + 3, 200), root(5, t + 4, 200), root(6, t + 5, 200)],
        {
          "deployment.environment": "production",
        },
      ),
    );
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const routeCount = async (query: string) => {
    const r = await server.json<RouteStatsResponse>(`/api/v1/routes?${query}`);
    return r.routes.reduce((n, x) => n + x.count, 0);
  };

  it("keeps the same service apart per environment, and every environment when none is given", async () => {
    expect(await routeCount("service=shop")).toBe(6);
    expect(await routeCount("service=shop&environment=production")).toBe(3);
    expect(await routeCount("service=shop&environment=staging")).toBe(2);
    expect(await routeCount("service=shop&environment=unset")).toBe(1);
    expect(await routeCount("service=shop&environment=nowhere")).toBe(0);
  });

  it("filters the trace list, and data stored without an environment stays visible as unset", async () => {
    const list = async (q: string) =>
      (await server.json<TraceListResponse>(`/api/v1/traces?${q}`)).items.map(
        (i) => i.traceId,
      );
    expect((await list("environment=staging")).sort()).toEqual([
      tid(2),
      tid(3),
    ]);
    expect(await list("environment=unset")).toEqual([tid(1)]);
    expect(await list("")).toHaveLength(6);
  });

  it("lists the environments in meta, most recently seen first, with their services", async () => {
    const meta = await server.json<MetaResponse>("/api/v1/meta");
    // The seed wrote unset, then staging, then production: most recently seen first.
    expect(meta.environments?.map((e) => e.name)).toEqual([
      "production",
      "staging",
      "unset",
    ]);
    const unset = meta.environments?.find((e) => e.name === "unset");
    expect(unset).toMatchObject({ unset: true, services: ["shop"] });
    expect(meta.environments?.find((e) => e.name === "staging")?.unset).toBe(
      false,
    );
  });

  it("sums the rollups read by alert rules and SLOs per environment", async () => {
    for (const environment of ["production", "staging", null] as const) {
      await seedMinute(db.pool, {
        minuteMs: NOW - MIN,
        service: "api",
        environment,
        count: environment === "staging" ? 10 : 100,
        errors: environment === "staging" ? 5 : 0,
      });
    }
    const totals = (environment: string | null) =>
      rangeTotals(db.pool, "api", environment, null, NOW - 5 * MIN, NOW);
    expect((await totals("staging")).errors).toBe(5);
    expect((await totals("production")).count).toBe(100);
    expect((await totals("unset")).count).toBe(100);
    // `null` is every environment.
    expect((await totals(null)).count).toBe(210);
  });
});

/** Two environments of one service, each with names only it uses ("stg" and "prd" markers). */
describe.skipIf(noDatabase)(
  `environment isolation, endpoint by endpoint ${skipReason}`,
  () => {
    let db: TestDb;
    let server: QueryServer;
    const t = Math.floor((NOW - 2 * MIN) / MIN) * MIN + 10_000;
    const ENVS = [
      { name: "staging", m: "stgx", other: "prdx", n: 2 },
      { name: "production", m: "prdx", other: "stgx", n: 3 },
    ] as const;

    const point = (instance: string, value: number) => ({
      serviceName: "shop",
      environment: null as string | null,
      instanceId: instance,
      points: [
        {
          metric: "process.memory.usage",
          kind: "gauge" as const,
          temporality: "cumulative" as const,
          attributes: {},
          attributesKey: "{}",
          timeUnixNano: nsAt(t),
          startTimeUnixNano: 0n,
          value,
        },
      ],
    });

    beforeAll(async () => {
      db = await createTestDb("env_isolation");
      server = await startQueryServer(db.url, true, true, {
        NESTRIX_METRICS: "on",
      });
      const sink = server.app.get(PostgresIngestSink);
      let n = 100;
      for (const env of ENVS) {
        const resource = {
          "deployment.environment.name": env.name,
          "service.version": `${env.m}-1`,
        };
        for (let i = 0; i < env.n; i++) {
          const trace = tid(++n);
          const rootId = sid(n);
          const at = t + n;
          await sink.write(
            batch(
              "shop",
              [
                span({
                  traceId: trace,
                  spanId: rootId,
                  name: `GET /${env.m}-orders`,
                  kind: "server",
                  startMs: at,
                  durationMs: 40,
                  attributes: {
                    "http.request.method": "GET",
                    "http.route": `/${env.m}-orders`,
                    "http.response.status_code": 500,
                  },
                  status: { code: "error" },
                  events: [
                    {
                      name: "exception",
                      timeUnixNano: nsAt(at),
                      attributes: {
                        "exception.type": "Error",
                        "exception.message": `${env.m}-boom`,
                        "exception.stacktrace": `Error: ${env.m}-boom\n    at x (a.js:1:1)`,
                      },
                    },
                  ],
                }),
                span({
                  traceId: trace,
                  spanId: sid(n + 5000),
                  parentSpanId: rootId,
                  name: `${env.m}.method`,
                  kind: "internal",
                  startMs: at + 1,
                  durationMs: 10,
                  attributes: {
                    "nestrix.class": `${env.m}Service`,
                    "nestrix.method": "run",
                    "nestrix.component": "provider",
                  },
                }),
                span({
                  traceId: trace,
                  spanId: sid(n + 6000),
                  parentSpanId: rootId,
                  name: `${env.m}.query`,
                  kind: "client",
                  startMs: at + 2,
                  durationMs: 12,
                  attributes: {
                    "db.system.name": "postgresql",
                    "server.address": `${env.m}-db.local`,
                    "db.query.text": `SELECT '${env.m}' FROM t`,
                  },
                }),
              ],
              resource,
            ),
          );
          await sink.writeLogs({
            resourceLogs: [
              {
                resource: {
                  "service.name": "shop",
                  "deployment.environment.name": env.name,
                },
                records: [
                  {
                    traceId: trace,
                    timeUnixNano: nsAt(at),
                    severityNumber: 17,
                    severityText: "ERROR",
                    body: `${env.m}-log line`,
                  },
                ],
              },
            ],
            rejectedLogRecords: 0,
          });
        }
        await db.pool.query(
          `INSERT INTO instances (service, instance_id, principal, environment, host)
           VALUES ('shop', $1, 'key:test', $2, $3)`,
          [`${env.m}-instance`, env.name, `${env.m}-host`],
        );
        await sink.writeMetrics({
          resourceMetrics: [
            {
              ...point(`${env.m}-instance`, env.n * 100),
              environment: env.name,
            },
          ],
          rejectedDataPoints: 0,
          dropped: {
            unsupportedType: 0,
            notStored: 0,
            typeMismatch: 0,
            noRecordedValue: 0,
          },
        } satisfies IngestMetricBatch);
      }
    }, 60_000);
    afterAll(async () => {
      await server?.close();
      await db?.drop();
    });

    const fetchText = async (path: string, environment?: string) => {
      const sep = path.includes("?") ? "&" : "?";
      const full =
        environment === undefined
          ? path
          : `${path}${sep}environment=${environment}`;
      const res = await server.get(`/api/v1/${full}`);
      expect(res.status, full).toBe(200);
      return res.text();
    };

    // `own: false` for an endpoint whose answer carries no names to tell the environments apart;
    // it must still differ from the all-environments answer.
    const WINDOW = "windowMinutes=15";
    const endpoints: { path: string; own?: boolean }[] = [
      { path: "errors" },
      { path: `errors/groups?${WINDOW}` },
      { path: "errors/insights" },
      { path: `overview?${WINDOW}`, own: false },
      { path: `classes?${WINDOW}` },
      { path: `map?${WINDOW}`, own: false },
      { path: `dependencies?${WINDOW}` },
      { path: `queries?${WINDOW}` },
      { path: `routes?${WINDOW}` },
      { path: `routes/compare?${WINDOW}` },
      { path: `traces/timeline?${WINDOW}`, own: false },
      { path: "traces" },
      { path: "instances" },
      { path: "logs" },
      { path: "metrics/catalog" },
    ];

    for (const { path, own = true } of endpoints) {
      it(`${path}: an environment's answer holds none of the other's data`, async () => {
        const all = await fetchText(path);
        for (const env of ENVS) {
          const scoped = await fetchText(path, env.name);
          expect(scoped, `${env.name} differs from every environment`).not.toBe(
            all,
          );
          expect(scoped).not.toContain(env.other);
          if (own) expect(scoped).toContain(env.m);
        }
      });
    }

    it("routes/compare between releases lists only the routes of the environment asked for", async () => {
      const routes = async (environment?: string) =>
        (
          JSON.parse(
            await fetchText(
              "routes/compare?releaseA=stgx-1&releaseB=prdx-1",
              environment,
            ),
          ) as { routes: { route: string }[] }
        ).routes
          .map((r) => r.route)
          .sort();
      expect(await routes()).toEqual(["/prdx-orders", "/stgx-orders"]);
      expect(await routes("staging")).toEqual(["/stgx-orders"]);
      expect(await routes("production")).toEqual(["/prdx-orders"]);
    });

    it("routes/explain and routes/histogram answer for the route's own environment only", async () => {
      for (const env of ENVS) {
        const own = await fetchText(
          `routes/explain?route=/${env.m}-orders&method=GET&windowMinutes=15`,
          env.name,
        );
        const cross = await fetchText(
          `routes/explain?route=/${env.other}-orders&method=GET&windowMinutes=15`,
          env.name,
        );
        expect(own).not.toBe(cross);
        // The other environment's route has no data in this one: nothing but its own name.
        expect(cross).not.toContain(`${env.other}Service`);
        expect(cross).not.toContain(`${env.other}-boom`);
        const histogram = JSON.parse(
          await fetchText(
            `routes/histogram?route=/${env.other}-orders&method=GET&windowMinutes=15`,
            env.name,
          ),
        );
        expect(JSON.stringify(histogram)).not.toMatch(/"count":[1-9]/);
      }
    });

    it("metrics/series sums one environment's instances only", async () => {
      const from = t - 5 * MIN;
      const series = async (environment: string) =>
        JSON.parse(
          await fetchText(
            `metrics/series?metric=process.memory.usage&fromUnixMs=${from}&toUnixMs=${t + 5 * MIN}&stepMs=60000&aggregation=max`,
            environment,
          ),
        ) as { series: { values: (number | null)[] }[] };
      const max = (r: Awaited<ReturnType<typeof series>>) =>
        Math.max(
          ...r.series.flatMap((s) =>
            s.values.map((v) => v ?? Number.NEGATIVE_INFINITY),
          ),
        );
      expect(max(await series("staging"))).toBe(200);
      expect(max(await series("production"))).toBe(300);
    });
  },
);

describe.skipIf(noDatabase)(`environment hardening ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  const t = Math.floor((NOW - 2 * MIN) / MIN) * MIN + 10_000;

  beforeAll(async () => {
    db = await createTestDb("env_hardening");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "on",
      NESTRIX_LOGS: "all",
    });
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("a span of another environment cannot take over a stored trace's root", async () => {
    const sink = server.app.get(PostgresIngestSink);
    const trace = tid(900);
    await sink.write(
      batch(
        "shop",
        [
          span({
            traceId: trace,
            spanId: sid(900),
            parentSpanId: sid(899),
            name: "GET /prod-route",
            kind: "server",
            startMs: t,
            durationMs: 20,
            attributes: {
              "http.request.method": "GET",
              "http.route": "/prod-route",
              "http.response.status_code": 200,
            },
          }),
        ],
        { "deployment.environment.name": "production" },
      ),
    );
    // A staging span that is parentless and earlier: it would win the root in a single environment.
    await sink.write(
      batch(
        "shop",
        [
          span({
            traceId: trace,
            spanId: sid(901),
            name: "GET /staging-hijack",
            kind: "server",
            startMs: t - 5_000,
            durationMs: 20,
            attributes: {
              "http.request.method": "GET",
              "http.route": "/staging-hijack",
              "http.response.status_code": 200,
            },
          }),
        ],
        { "deployment.environment.name": "staging" },
      ),
    );
    const { rows } = await db.pool.query<{
      root_span_id: string;
      environment: string | null;
      name: string;
      span_count: number;
    }>(
      "SELECT root_span_id, environment, name, span_count FROM traces WHERE trace_id = $1",
      [trace],
    );
    expect(rows).toEqual([
      {
        root_span_id: sid(900),
        environment: "production",
        name: "GET /prod-route",
        span_count: 2,
      },
    ]);
    // Same environment: the earlier parentless span still becomes the root.
    await sink.write(
      batch(
        "shop",
        [
          span({
            traceId: trace,
            spanId: sid(902),
            name: "GET /prod-real-root",
            kind: "server",
            startMs: t - 1_000,
            durationMs: 20,
          }),
        ],
        { "deployment.environment.name": "production" },
      ),
    );
    const after = await db.pool.query<{ root_span_id: string }>(
      "SELECT root_span_id FROM traces WHERE trace_id = $1",
      [trace],
    );
    expect(after.rows[0]?.root_span_id).toBe(sid(902));
  });

  it("an environment that only sends logs, or only metrics, is listed", async () => {
    const sink = server.app.get(PostgresIngestSink);
    await sink.writeLogs({
      resourceLogs: [
        {
          resource: {
            "service.name": "worker",
            "deployment.environment.name": "logs-only",
          },
          records: [
            {
              traceId: "",
              timeUnixNano: nsAt(t),
              severityNumber: 9,
              severityText: "INFO",
              body: "hello",
            },
          ],
        },
      ],
      rejectedLogRecords: 0,
    });
    await sink.writeMetrics({
      resourceMetrics: [
        {
          serviceName: "agent",
          environment: "metrics-only",
          instanceId: "i",
          points: [
            {
              metric: "process.memory.usage",
              kind: "gauge",
              temporality: "cumulative",
              attributes: {},
              attributesKey: "{}",
              timeUnixNano: nsAt(t),
              startTimeUnixNano: 0n,
              value: 1,
            },
          ],
        },
      ],
      rejectedDataPoints: 0,
      dropped: {
        unsupportedType: 0,
        notStored: 0,
        typeMismatch: 0,
        noRecordedValue: 0,
      },
    });
    const meta = await server.json<MetaResponse>("/api/v1/meta");
    const byName = new Map(meta.environments?.map((e) => [e.name, e]));
    expect(byName.get("logs-only")?.services).toEqual(["worker"]);
    expect(byName.get("metrics-only")?.services).toEqual(["agent"]);
  });
});
