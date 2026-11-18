/**
 * Issue #18 merged with #28 (D-105, D-101): metric points are stored under the environment of their
 * resource, or of the bound ingest key whatever the resource claims, and the catalog and series
 * routes take `environment` like every other route, over short and long ranges.
 */
import "reflect-metadata";
import type {
  MetricCatalogResponse,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, JSON_TYPE, KEY, OTHER_KEY, post } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const BASE = Math.floor((NOW - 30 * MIN) / MIN) * MIN;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const attr = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

function resource(
  instance: string,
  metrics: unknown[],
  environment?: string,
): unknown {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr("service.name", "shop"),
            attr("service.instance.id", instance),
            ...(environment === undefined
              ? []
              : [attr("deployment.environment.name", environment)]),
          ],
        },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
}

const memory = (t: number, value: number) => ({
  name: "process.memory.usage",
  unit: "By",
  gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: value }] },
});

const cpu = (t: number, value: number) => ({
  name: "process.cpu.time",
  unit: "s",
  sum: {
    isMonotonic: true,
    aggregationTemporality: 2,
    dataPoints: [
      {
        startTimeUnixNano: ns(BASE - MIN),
        timeUnixNano: ns(t),
        asDouble: value,
        attributes: [attr("cpu.mode", "user")],
      },
    ],
  },
});

describe.skipIf(noDatabase)(`metrics per environment ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;

  const send = async (body: unknown, key: string) => {
    const res = await post(
      `${server.baseUrl}/v1/metrics`,
      JSON.stringify(body),
      {
        "content-type": JSON_TYPE,
        ...auth(key),
      },
    );
    expect(res.status).toBe(200);
  };
  const series = (
    q: string,
    from = BASE,
    to = BASE + 10 * MIN,
    step = "&stepMs=60000",
  ) =>
    server.json<MetricSeriesResponse>(
      `/api/v1/metrics/series?fromUnixMs=${from}&toUnixMs=${to}${step}&${q}`,
    );

  beforeAll(async () => {
    db = await createTestDb("metrics_env");
    // KEY is bound to staging; OTHER_KEY is not, so its resources name their environment.
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_METRICS: "on",
      NESTRIX_INGEST_KEYS: `staging:${KEY},${OTHER_KEY}`,
    });
    for (let i = 0; i < 10; i++) {
      const t = BASE + i * MIN + 5_000;
      // Production, from the resource: memory 100, instance x at 0.5 cpu-s/s.
      await send(resource("p", [memory(t, 100)], "production"), OTHER_KEY);
      await send(resource("x", [cpu(t, i * 30)], "production"), OTHER_KEY);
      // The bound key: staging whatever the resource claims. Memory 200, instance x at 0.25.
      await send(resource("s", [memory(t, 200)], "production"), KEY);
      await send(resource("x", [cpu(t, i * 15)], "production"), KEY);
      // No environment: memory 300.
      await send(resource("u", [memory(t, 300)]), OTHER_KEY);
    }
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("the catalog lists the instances of the environment asked for", async () => {
    const catalog = (q: string) =>
      server.json<MetricCatalogResponse>(
        `/api/v1/metrics/catalog?fromUnixMs=${BASE}&toUnixMs=${BASE + 10 * MIN}${q}`,
      );
    const all = await catalog("");
    expect(
      all.instances
        .map((i) => `${i.environment ?? "-"}/${i.instanceId}`)
        .sort(),
    ).toEqual([
      "-/u",
      "production/p",
      "production/x",
      "staging/s",
      "staging/x",
    ]);
    const staging = await catalog("&environment=staging");
    expect(staging.services).toEqual(["shop"]);
    expect(staging.instances.map((i) => i.instanceId).sort()).toEqual([
      "s",
      "x",
    ]);
    const unset = await catalog("&environment=unset");
    expect(unset.instances.map((i) => i.instanceId)).toEqual(["u"]);
    expect(unset.instances[0]?.environment).toBeUndefined();
    expect((await catalog("&environment=qa")).instances).toEqual([]);
  });

  it("a gauge is read per environment; the bound key's points are staging", async () => {
    const at5 = async (q: string) =>
      (await series(`metric=process.memory.usage&${q}`)).series[0]?.values[5];
    expect(await at5("environment=production")).toBeCloseTo(100, 6);
    expect(await at5("environment=staging")).toBeCloseTo(200, 6);
    expect(await at5("environment=unset")).toBeCloseTo(300, 6);
    expect(await at5("environment=qa")).toBeNull();
    expect(await at5("")).toBeCloseTo(200, 6);
  });

  it("a counter's consecutive rows are taken per environment, even for one instance id", async () => {
    const at5 = async (q: string) =>
      (await series(`metric=process.cpu.time&instance=x&${q}`)).series[0]
        ?.values[5];
    expect(await at5("environment=production")).toBeCloseTo(0.5, 6);
    expect(await at5("environment=staging")).toBeCloseTo(0.25, 6);
    // Across environments the two series add up; mixed into one series they would not.
    expect(await at5("")).toBeCloseTo(0.75, 6);
  });

  it("ranges of 7 and 30 days are read per environment", async () => {
    for (const days of [7, 30]) {
      for (const [environment, value] of [
        ["production", 100],
        ["staging", 200],
        ["unset", 300],
      ] as const) {
        const s = await series(
          `metric=process.memory.usage&environment=${environment}`,
          NOW - days * DAY,
          NOW,
          "",
        );
        const seen = (s.series[0]?.values ?? []).filter(
          (v): v is number => v !== null,
        );
        expect(seen.length, `${days} d ${environment}`).toBeGreaterThan(0);
        for (const v of seen) expect(v).toBeCloseTo(value, 6);
      }
    }
  });
});
