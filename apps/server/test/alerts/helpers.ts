import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type pg from "pg";
import {
  ALERTS_OPTIONS,
  type ResolvedAlertsOptions,
} from "../../src/alerts/tokens.js";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import type { ServerConfig } from "../../src/config.js";
import { SERVER_CONFIG } from "../../src/config.module.js";
import { bucketIndex, HISTOGRAM_BUCKETS } from "../../src/storage/histogram.js";
import { ADMIN_PW, SESSION_SECRET, signedCookie } from "../auth/helpers.js";
import { lastServer, testConfig } from "../ingest/helpers.js";

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  url: string;
  port: number;
  requests: Received[];
  /** Highest number of requests handled at the same time. */
  maxConcurrent: number;
  close(): Promise<void>;
}

/**
 * A local HTTP server that records every request. `respond` decides the answer (default 200);
 * it may return a promise to delay the answer, or "hang" to never answer.
 */
export async function startReceiver(
  respond: (
    req: Received,
    res: ServerResponse,
    index: number,
  ) => void | "hang" | Promise<void> = (_r, res) => {
    res.writeHead(200).end("ok");
  },
): Promise<Receiver> {
  const requests: Received[] = [];
  let current = 0;
  const state = { maxConcurrent: 0 };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      current++;
      state.maxConcurrent = Math.max(state.maxConcurrent, current);
      const received: Received = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const index = requests.push(received) - 1;
      res.on("close", () => current--);
      try {
        await respond(received, res, index);
      } catch {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    requests,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Verifies a received webhook as a receiver would: `sha256=` HMAC of `<timestamp>.<body>`. */
export function verifySignature(r: Received, secret: string): boolean {
  const ts = r.headers["x-nestrix-timestamp"];
  const sig = r.headers["x-nestrix-signature"];
  if (typeof ts !== "string" || typeof sig !== "string") return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${r.body}`).digest("hex")}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Inserts one `route_minutes` row with `count` requests of `durationMs` each, `errors` of them errors. */
export async function seedMinute(
  pool: pg.Pool,
  init: {
    minuteMs: number;
    service: string;
    route?: string;
    method?: string;
    count: number;
    errors: number;
    durationMs?: number;
  },
): Promise<void> {
  const duration = init.durationMs ?? 10;
  const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  hist[bucketIndex(duration)] = init.count;
  await pool.query(
    `INSERT INTO route_minutes (minute, service_name, method, route, count, errors, total_ms, max_ms, hist)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (minute, service_name, method, route) DO UPDATE
       SET count = EXCLUDED.count, errors = EXCLUDED.errors, total_ms = EXCLUDED.total_ms,
           max_ms = EXCLUDED.max_ms, hist = EXCLUDED.hist`,
    [
      new Date(Math.floor(init.minuteMs / 60_000) * 60_000),
      init.service,
      init.method ?? "GET",
      init.route ?? "/orders",
      init.count,
      init.errors,
      duration * init.count,
      duration,
      hist,
    ],
  );
}

export interface AlertsServer {
  app: NestExpressApplication;
  baseUrl: string;
  origin: string;
  cookie: string;
  /** A request with the session cookie and a same-origin `Origin` (unless overridden). */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  close(): Promise<void>;
}

/**
 * The whole server against `databaseUrl`, with alert scheduling off (tests drive the evaluator)
 * and fast webhook retries.
 */
export async function startAlertsServer(
  databaseUrl: string,
  env: Record<string, string> = {},
  overrides: Partial<ResolvedAlertsOptions> = {},
): Promise<AlertsServer> {
  const config = testConfig({
    DATABASE_URL: databaseUrl,
    NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
    NESTRIX_SESSION_SECRET: SESSION_SECRET,
    ...env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  })
    .overrideProvider(ALERTS_OPTIONS)
    .useFactory({
      inject: [SERVER_CONFIG],
      factory: (c: ServerConfig): ResolvedAlertsOptions => ({
        schedule: false,
        webhook: { backoffMs: () => 10, timeoutMs: 1000 },
        publicUrl: c.alerts.publicUrl,
        allowedHosts: c.alerts.allowedHosts,
        retentionDays: c.retentionDays,
        ...overrides,
      }),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, config);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  lastServer.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = signedCookie(undefined, undefined, undefined, port);
  return {
    app,
    baseUrl,
    origin: baseUrl,
    cookie,
    call: (method, path, body, headers = {}) =>
      fetch(`${baseUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          cookie,
          origin: baseUrl,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    close: async () => {
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}
