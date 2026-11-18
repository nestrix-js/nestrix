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
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { seedMinute } from "../alerts/helpers.js";
import {
  batch,
  createTestDb,
  noDatabase,
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
    expect(meta.environments?.map((e) => e.name).sort()).toEqual([
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
