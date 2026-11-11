// Shared fixture for the stats-*.test.ts files (P2-04). Not a test file itself.
//
// `NestrixCore` does not pass a dashboard config to the request hook yet (P2-06 wires it from
// the resolved `ui` mode). These tests stand in for that wiring: `StatsCore` is a copy of
// `NestrixCore`'s constructor that passes one, and `FakeDashboard` registers dashboard-like
// routes the way P2-06 will (`httpAdapter.get` in `onModuleInit`, hijack, raw write).
import "reflect-metadata";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BadRequestException,
  Controller,
  Get,
  type INestApplication,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Param,
  type Type,
} from "@nestjs/common";
import { APP_INTERCEPTOR, HttpAdapterHost, NestFactory } from "@nestjs/core";
import { trace } from "@opentelemetry/api";
import { diagnostics } from "../src/diagnostics.js";
import { NestrixInterceptor } from "../src/http/interceptor.js";
import { markDashboardHandlerReached } from "../src/http/request-state.js";
import {
  type DashboardHookConfig,
  installHttpInstrumentation,
} from "../src/http/server.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "../src/privacy.js";
import { resolveOptions } from "../src/resolve-options.js";
import { RouteStatistics } from "../src/stats/route-stats.js";

export const DASHBOARD_PATH = "/_nestrix";

/** Counts what the handlers saw, including whether the active (Nestrix) span was recording. */
export const seen = { handled: 0, recording: 0 };

@Controller("s")
export class StatsController {
  @Get("ok/:id")
  ok(@Param("id") id: string): { id: string } {
    seen.handled++;
    if (trace.getActiveSpan()?.isRecording() === true) seen.recording++;
    return { id };
  }

  @Get("boom")
  boom(): never {
    seen.handled++;
    if (trace.getActiveSpan()?.isRecording() === true) seen.recording++;
    throw new Error("boom");
  }

  @Get("bad")
  bad(): never {
    throw new BadRequestException("bad");
  }
}

/** A host route under the dashboard path that the dashboard does not own: shadowing, 200. */
@Controller("_nestrix")
export class HostUnderDashboardController {
  @Get("host")
  host(): string {
    return "host-route";
  }
}

/** A slow route, so a client can go away while the handler is still running. */
@Controller("slow")
export class SlowController {
  @Get()
  async slow(): Promise<string> {
    await new Promise((r) => setTimeout(r, 300));
    return "slow";
  }
}

/** A host catch-all route, Express and platform-node syntax (P0-S5 Q3). */
@Controller()
export class CatchAllController {
  @Get("*splat")
  all(): string {
    return "host-catch-all";
  }
}

export interface StatsHarness {
  stats: RouteStatistics;
  shadowed: number[];
  dashboard: DashboardHookConfig;
}

export function newHarness(
  onShadowed?: (status: number) => unknown,
): StatsHarness {
  const stats = new RouteStatistics();
  const shadowed: number[] = [];
  return {
    stats,
    shadowed,
    dashboard: {
      dashboardPath: DASHBOARD_PATH,
      stats,
      onShadowed: (status) => {
        shadowed.push(status);
        return onShadowed?.(status);
      },
    },
  };
}

export interface StatsModuleOptions {
  controllers: Type[];
  /** Passed to the request hook; `undefined` means the dashboard is off. */
  dashboard: DashboardHookConfig | undefined;
  /** Nestrix sets up its own provider (no host SDK registered). */
  telemetry: boolean;
  /** Register the fake dashboard routes. */
  mount: boolean;
  options?: NestrixModuleOptions;
}

export function statsModule(o: StatsModuleOptions): Type {
  const resolved = resolveOptions(o.options ?? { export: { otlp: false } }, {});

  /** `NestrixCore`'s constructor, plus the dashboard config. */
  @Injectable()
  class StatsCore implements OnApplicationShutdown {
    private readonly telemetry: TelemetryHandle | undefined;
    private readonly dispose: () => void;
    constructor(@Inject(HttpAdapterHost) adapterHost: HttpAdapterHost) {
      if (o.telemetry) {
        const queryKeys = buildRedactedQueryKeys(resolved.http.redactQueryKeys);
        this.telemetry = setupTelemetry(
          {
            ...resolved,
            scrub: (span) => scrubSpanAttributes(span, queryKeys),
          },
          diagnostics,
        );
      }
      this.dispose = installHttpInstrumentation(
        adapterHost,
        resolved,
        diagnostics,
        o.dashboard,
      );
    }
    async onApplicationShutdown(): Promise<void> {
      this.dispose();
      await this.telemetry?.shutdown();
    }
  }

  /** Registers dashboard-like routes as P2-06 will: mark, hijack, raw write. */
  @Injectable()
  class FakeDashboard implements OnModuleInit {
    constructor(
      @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    ) {}
    onModuleInit(): void {
      if (!o.mount) return;
      const adapter = this.host.httpAdapter;
      for (const path of [
        DASHBOARD_PATH,
        `${DASHBOARD_PATH}/`,
        `${DASHBOARD_PATH}/api/v1/meta`,
      ]) {
        adapter.get(path, (req: unknown, res: unknown) => {
          markDashboardHandlerReached(req);
          const reply = res as { hijack?: () => void; raw?: unknown };
          if (typeof reply.hijack === "function") reply.hijack();
          const raw = (reply.raw ?? res) as {
            statusCode: number;
            setHeader(name: string, value: string): void;
            end(body: string): void;
          };
          raw.statusCode = 200;
          raw.setHeader("content-type", "application/json");
          raw.end('{"dashboard":true}');
        });
      }
    }
  }

  @Module({
    controllers: o.controllers,
    providers: [
      StatsCore,
      FakeDashboard,
      { provide: APP_INTERCEPTOR, useClass: NestrixInterceptor },
    ],
  })
  class StatsRoot {}
  return StatsRoot;
}

export type AdapterName = "express" | "fastify" | "node";

// The platform packages are dependencies of `@nestrix/testing`, not of this package, so they
// are resolved from there (the same `@nestjs/core` instance: one pnpm peer set).
const fromTesting = createRequire(
  fileURLToPath(import.meta.resolve("@nestrix/testing")),
);
const PLATFORM = {
  express: ["@nestjs/platform-express", "ExpressAdapter"],
  fastify: ["@nestjs/platform-fastify", "FastifyAdapter"],
  node: ["@nestjs/platform-node", "NodeAdapter"],
} as const;

/** Boots without `bootApp` (which registers a host provider first). */
export async function bootOwned(
  adapter: AdapterName,
  module: Type,
): Promise<{ app: INestApplication; baseUrl: string }> {
  const [pkg, name] = PLATFORM[adapter];
  const mod = (await import(
    pathToFileURL(fromTesting.resolve(pkg)).href
  )) as Record<string, new () => never>;
  const Adapter = mod[name] as new () => never;
  const app = await NestFactory.create(module, new Adapter(), {
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** Sends `paths` with at most `concurrency` in flight; returns the statuses in order. */
export async function sendAll(
  baseUrl: string,
  paths: string[],
  concurrency = 16,
): Promise<number[]> {
  const statuses: number[] = new Array(paths.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < paths.length) {
      const i = next++;
      const res = await fetch(`${baseUrl}${paths[i]}`);
      await res.arrayBuffer();
      statuses[i] = res.status;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return statuses;
}

/** `METHOD route` → count, from a 60-minute query. */
export function counts(stats: RouteStatistics): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of stats.query(60).routes)
    out[`${r.method} ${r.route}`] = r.count;
  return out;
}

export function errorCounts(stats: RouteStatistics): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of stats.query(60).routes)
    out[`${r.method} ${r.route}`] = r.errors;
  return out;
}
