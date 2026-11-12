// P10-01: `export.profiler` through `NestrixModule`, in apps without an HTTP adapter
// (`createApplicationContext`) and under `@nestjs/testing`, against a fake standalone server.
// Global state: none registered before Nestrix (each app owns, then releases, the provider).
import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NestrixCore } from "../src/core.js";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { resetProfilerForTests } from "../src/profiler/profiler.js";
import { remoteRuntime } from "../src/profiler/remote.js";
import { ADAPTERS, bootDashboardApp, TOKEN } from "./dashboard-fixture.js";
import {
  bodyJson,
  CHECK_IN,
  type FakeServer,
  sleep,
  startFakeServer,
  until,
} from "./profiler-remote-fixture.js";

let server: FakeServer;

beforeAll(async () => {
  server = await startFakeServer();
  remoteRuntime.timing = {
    firstMinMs: 10,
    firstMaxMs: 10,
    minIntervalMs: 20,
    jitter: 0,
  };
});
afterAll(async () => {
  remoteRuntime.timing = {};
  await server.close();
});
beforeEach(() => {
  server.hits.length = 0;
  server.respond = (hit) =>
    hit.path === CHECK_IN
      ? { status: 200, json: { nextCheckInMs: 20 } }
      : { status: 200, json: {} };
  resetDiagnosticsForTests();
  resetProfilerForTests();
  vi.restoreAllMocks();
});

function rootWith(options: NestrixModuleOptions) {
  @Module({ imports: [NestrixModule.forRoot(options)] })
  class Root {}
  return Root;
}

async function context(options: NestrixModuleOptions) {
  return NestFactory.createApplicationContext(rootWith(options), {
    logger: false,
  });
}

describe("export.profiler through NestrixModule", () => {
  it("checks in with the owned resource's identity and stops at close", async () => {
    const app = await context({
      serviceName: "remote-nest",
      serviceVersion: "9.9.9",
      ui: false,
      export: {
        profiler: true,
        otlp: {
          endpoint: `${server.url}/`,
          headers: { authorization: "Bearer ingest-1" },
        },
      },
    });
    const core = app.get(NestrixCore);
    expect(core.telemetry?.ownsProvider).toBe(true);
    await until(() => server.checkIns().length >= 2, 2000, "check-ins");
    const hit = server.checkIns()[0];
    expect(hit?.headers.authorization).toBe("Bearer ingest-1");
    const body = bodyJson(hit as never) as Record<string, unknown>;
    expect(body.service).toBe("remote-nest");
    expect(body.version).toBe("9.9.9");
    // The same id every exported span carries.
    expect(body.instanceId).toBe(
      core.telemetry?.resourceAttributes?.["service.instance.id"],
    );
    expect(typeof body.instanceId).toBe("string");
    // P15-03: process figures on every check-in; no dashboard, so no event-loop p99.
    const sample = body.runtimeSample as Record<string, number>;
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(sample.eventLoopP99Ms).toBeUndefined();

    await app.close();
    const after = server.checkIns().length;
    await sleep(150);
    expect(server.checkIns().length).toBe(after);
    expect([...getFailureCounts().keys()]).toEqual([]);
  });

  it("off by default: an endpoint alone sends no check-in", async () => {
    const app = await context({
      ui: false,
      export: { otlp: { endpoint: server.url } },
    });
    await sleep(200);
    await app.close();
    expect(server.checkIns()).toEqual([]);
  });

  it("on without an endpoint (otlp: false): nothing is sent, one line says why", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const app = await context({
      ui: false,
      export: { profiler: true, otlp: false },
    });
    await sleep(100);
    await app.close();
    expect(server.hits).toEqual([]);
    expect(
      log.mock.calls.filter((c) =>
        String(c[0]).includes("export.profiler is on, but no export endpoint"),
      ),
    ).toHaveLength(1);
  });

  it("enabled: false builds no poller", async () => {
    const app = await context({
      enabled: false,
      export: { profiler: true, otlp: { endpoint: server.url } },
    });
    await sleep(100);
    await app.close();
    expect(server.hits).toEqual([]);
  });

  it("under @nestjs/testing: checks in after init, stops at close", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestrixModule.forRoot({
          ui: false,
          export: { profiler: true, otlp: { endpoint: server.url } },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await until(() => server.checkIns().length >= 1, 2000, "a check-in");
    await app.close();
    const after = server.checkIns().length;
    await sleep(100);
    expect(server.checkIns().length).toBe(after);
  });

  for (const adapter of ADAPTERS) {
    it(`P15-03 (${adapter}): with the dashboard mounted, the check-in carries its sampler's event-loop p99`, async () => {
      const booted = await bootDashboardApp({
        adapter,
        nestrix: {
          ui: { enabled: true, auth: { token: TOKEN } },
          export: { profiler: true, otlp: { endpoint: `${server.url}/` } },
        },
      });
      try {
        await until(() => server.checkIns().length >= 1, 2000, "a check-in");
        // The sampler records every 10 s; take one now instead of waiting, once the real
        // histogram has seen the loop for a while.
        await sleep(150);
        const core = booted.app.get(NestrixCore);
        const board = (
          core as unknown as {
            dashboard?: { runtime: { sample(): void } };
          }
        ).dashboard;
        expect(board).toBeDefined();
        board?.runtime.sample();
        const seen = server.checkIns().length;
        await until(
          () => server.checkIns().length > seen,
          2000,
          "a later check-in",
        );
        const sample = (
          bodyJson(server.checkIns().at(-1) as never) as {
            runtimeSample?: Record<string, number>;
          }
        ).runtimeSample;
        expect(sample?.eventLoopP99Ms).toBeGreaterThanOrEqual(0);
        expect(sample?.rssBytes).toBeGreaterThan(0);
      } finally {
        await booted.close();
      }
      expect([...getFailureCounts().keys()]).toEqual([]);
    });
  }

  it("a 404 endpoint (a Collector) stops polling and the app keeps running", async () => {
    server.respond = () => ({ status: 404 });
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const app = await context({
      ui: false,
      export: { profiler: true, otlp: { endpoint: server.url } },
    });
    await until(() => server.checkIns().length === 1, 2000);
    await sleep(150);
    expect(server.checkIns()).toHaveLength(1);
    expect(
      log.mock.calls.filter((c) =>
        String(c[0]).includes("not a Nestrix server"),
      ),
    ).toHaveLength(1);
    await app.close();
  });
});
