// Shared fixture for the dashboard-*.test.ts files (P2-06). Not a test file itself.
//
// Boots a real host application with `NestrixModule.forRoot()` on each adapter, through
// `NestFactory` or `@nestjs/testing`, with whatever host layers a test asks for (global prefix,
// URI versioning, `useSecurityHeaders()`, permissive CORS), and listens on a real socket.
import "reflect-metadata";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  type INestApplication,
  Module,
  type Type,
  VersioningType,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";

export type AdapterName = "express" | "fastify" | "node";
export const ADAPTERS: AdapterName[] = ["express", "fastify", "node"];

/** A test value for the built-in token authenticator (at least 32 characters). */
export const TOKEN = "x".repeat(40);
export const BEARER = { authorization: `Bearer ${TOKEN}` };
export const EVIL_ORIGIN = "http://evil.example";

export const NESTRIX_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

/** What the host's global exception filter saw: a dashboard fault must never reach it. */
export const hostFilter = { calls: 0 };

@Catch()
export class CountingFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    hostFilter.calls++;
    const res = host.switchToHttp().getResponse() as { raw?: unknown };
    const raw = (res.raw ?? res) as {
      statusCode: number;
      end(body: string): void;
    };
    raw.statusCode = 500;
    raw.end("host-filter");
  }
}

@Controller("h")
export class HostController {
  @Get("ok")
  ok(): string {
    return "ok";
  }

  /** An object payload: Fastify's `preSerialization` hooks run only for those. */
  @Get("json")
  json(): { ok: boolean } {
    return { ok: true };
  }

  @Get("boom")
  boom(): never {
    throw new Error("host boom");
  }
}

/** A host catch-all, Express and platform-node syntax (P0-S5 Q3). */
@Controller()
export class CatchAllController {
  @Get("*splat")
  all(): string {
    return "host-catch-all";
  }
}

export interface DashboardAppOptions {
  adapter: AdapterName;
  nestrix: NestrixModuleOptions;
  controllers?: Type[];
  /** Global prefix `api` and URI versioning with default version `1`. */
  prefixAndVersioning?: boolean;
  securityHeaders?: boolean;
  /** `enableCors({ origin: true, credentials: true })`; on Fastify with `hook: 'preSerialization'`. */
  cors?: boolean;
  /** Build through `Test.createTestingModule(...).compile()`. */
  testing?: boolean;
  /** Register a counting global exception filter (`APP_FILTER`). */
  filter?: boolean;
  /** `false`: `init()` only, never `listen()`. */
  listen?: boolean;
  /** Runs after the host layers above, before `init()`/`listen()`. */
  configure?: (app: INestApplication) => void;
}

export interface DashboardApp {
  app: INestApplication;
  /** `http://127.0.0.1:<port>`; empty when not listening. */
  baseUrl: string;
  port: number;
  /** Where the host's own `GET h/ok` answers (prefix and version applied). */
  hostOk: string;
  close(): Promise<void>;
}

// The platform packages are dependencies of `@nestrix/testing`, not of this package (one pnpm
// peer set, the same `@nestjs/core` instance).
const fromTesting = createRequire(
  fileURLToPath(import.meta.resolve("@nestrix/testing")),
);
const PLATFORM = {
  express: ["@nestjs/platform-express", "ExpressAdapter"],
  fastify: ["@nestjs/platform-fastify", "FastifyAdapter"],
  node: ["@nestjs/platform-node", "NodeAdapter"],
} as const;

async function createAdapter(adapter: AdapterName): Promise<unknown> {
  const [pkg, name] = PLATFORM[adapter];
  const mod = (await import(
    pathToFileURL(fromTesting.resolve(pkg)).href
  )) as Record<string, new () => unknown>;
  return new (mod[name] as new () => unknown)();
}

export function dashboardRoot(o: DashboardAppOptions): Type {
  @Module({
    imports: [NestrixModule.forRoot(o.nestrix)],
    controllers: o.controllers ?? [HostController],
    providers: o.filter
      ? [{ provide: APP_FILTER, useClass: CountingFilter }]
      : [],
  })
  class DashboardRoot {}
  return DashboardRoot;
}

export async function bootDashboardApp(
  o: DashboardAppOptions,
): Promise<DashboardApp> {
  const root = dashboardRoot(o);
  const adapter = await createAdapter(o.adapter);
  let app: INestApplication;
  if (o.testing) {
    const moduleRef = await Test.createTestingModule({
      imports: [root],
    }).compile();
    app = moduleRef.createNestApplication(adapter as never, { logger: false });
  } else {
    app = await NestFactory.create(root, adapter as never, { logger: false });
  }
  if (o.prefixAndVersioning) {
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  }
  if (o.securityHeaders) app.useSecurityHeaders();
  if (o.cors) {
    app.enableCors({
      origin: true,
      credentials: true,
      ...(o.adapter === "fastify" ? { hook: "preSerialization" } : {}),
    } as never);
  }
  o.configure?.(app);
  let baseUrl = "";
  let port = 0;
  if (o.listen === false) {
    await app.init();
  } else {
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const hostOk = o.prefixAndVersioning ? "/api/v1/h/ok" : "/h/ok";
  return { app, baseUrl, port, hostOk, close: () => app.close() };
}

export interface Fetched {
  status: number;
  headers: Headers;
  body: Buffer;
  text: string;
  json: () => unknown;
}

export async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  const res = await fetch(url, { headers, redirect: "manual" });
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  return {
    status: res.status,
    headers: res.headers,
    body,
    text,
    json: () => JSON.parse(text),
  };
}

/** Names of `Access-Control-*` response headers. */
export function corsHeaders(headers: Headers): string[] {
  return [...headers.keys()].filter((k) =>
    k.toLowerCase().startsWith("access-control-"),
  );
}

/** Differences from the header set of backlog P2 "Public API" (empty when it is all there). */
export function headerProblems(
  r: Fetched,
  cacheControl = "no-store",
): string[] {
  const problems: string[] = [];
  const want: Record<string, string> = {
    "content-security-policy": NESTRIX_CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
    "cache-control": cacheControl,
  };
  for (const [name, value] of Object.entries(want)) {
    const got = r.headers.get(name);
    if (got !== value) problems.push(`${name}: ${String(got)}`);
  }
  const cors = corsHeaders(r.headers);
  if (cors.length > 0) problems.push(`cors: ${cors.join(",")}`);
  return problems;
}

export function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) resolve();
      else if (Date.now() - started > timeoutMs)
        reject(new Error("waitFor timed out"));
      else setTimeout(tick, 10);
    };
    tick();
  });
}
