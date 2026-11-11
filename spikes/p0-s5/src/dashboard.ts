import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { type AbstractHttpAdapter, HttpAdapterHost } from "@nestjs/core";
import { dashboardDirectory } from "@nestrix/ui";

/**
 * Stand-in for the dashboard: a JSON route, an HTML asset and a pre-gzipped
 * binary asset, registered through `httpAdapter.get(...)` only.
 */

export type WriteStrategy = "adapter" | "adapter-end" | "raw";

export interface MountOptions {
  /** Where the routes are registered: `onModuleInit` (the design) or the provider constructor (Q9). */
  when: "init" | "constructor" | "init$";
  /** After listen, send one request to our own probe route over loopback and record whether our handler got it (Q3). */
  selfProbe?: boolean;
  /**
   * Passive shadowing detection (review item 6): set from init$ a request hook
   * that marks requests under the base path, and a chained route-triggered hook.
   * A marked request that fires a host route, or closes without reaching our
   * handler, is recorded in probe.passive.
   */
  passive?: boolean;
  /** How a response is written: through `httpAdapter.status/setHeader/reply`, or on the raw `ServerResponse`. */
  strategy: WriteStrategy;
  /** Remove every `Access-Control-*` header the host set before the handler ran (Q5). */
  stripCors?: boolean | "raw-only";
  base?: string;
}

export const MOUNT_OPTIONS = Symbol("MOUNT_OPTIONS");

/** What the spike observed, read by the tests. Reset with `resetProbe()`. */
export const probe = {
  adapterAtConstruction: undefined as boolean | undefined,
  adapterAtInit: undefined as boolean | undefined,
  registered: [] as string[],
  registrationErrors: [] as string[],
  handlerErrors: [] as string[],
  nonces: [] as string[],
  hits: 0,
  order: [] as string[],
  selfProbe: undefined as Promise<string> | undefined,
  passive: [] as string[],
};

interface PassiveStore {
  url: string;
  reached: boolean;
  hostRoute?: string;
}
const passiveAls = new AsyncLocalStorage<PassiveStore>();

export function resetProbe(): void {
  probe.adapterAtConstruction = undefined;
  probe.adapterAtInit = undefined;
  probe.registered = [];
  probe.registrationErrors = [];
  probe.handlerErrors = [];
  probe.nonces = [];
  probe.hits = 0;
  probe.order = [];
  probe.selfProbe = undefined;
  probe.passive = [];
}

function installPassive(adapter: AbstractHttpAdapter, base: string): void {
  adapter.setOnRequestHook((req: unknown, res: unknown, done: () => void) => {
    let store: PassiveStore | undefined;
    try {
      const raw = rawOf(req, res);
      const url = raw.req.url ?? "";
      if (url === base || url.startsWith(`${base}/`)) {
        const s: PassiveStore = { url, reached: false };
        store = s;
        raw.res.once("close", () => {
          if (!s.reached)
            probe.passive.push(
              `shadowed ${s.url}${s.hostRoute ? ` by host route ${s.hostRoute}` : ""}`,
            );
        });
      }
    } catch {
      store = undefined;
    }
    if (store) passiveAls.run(store, done);
    else done();
  });
  const prev = adapter.getOnRouteTriggered?.();
  adapter.setOnRouteTriggered((method, path) => {
    try {
      const s = passiveAls.getStore();
      if (s) s.hostRoute = path;
    } catch {
      // ignore
    }
    prev?.(method, path);
  });
}

/** One loopback request to our probe route with a nonce; "reachable" if our handler saw it. */
function runSelfProbe(
  adapter: AbstractHttpAdapter,
  base: string,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      const address = adapter.getHttpServer()?.address();
      if (!address || typeof address === "string") {
        resolve("skipped: no TCP address");
        return;
      }
      const host =
        address.address === "::" || address.address === "0.0.0.0"
          ? address.family === "IPv6"
            ? "::1"
            : "127.0.0.1"
          : address.address;
      const nonce = randomBytes(8).toString("hex");
      const req = httpRequest(
        {
          host,
          port: address.port,
          path: `${base}/api/probe`,
          headers: { "x-nestrix-probe": nonce },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve(
              probe.nonces.includes(nonce)
                ? "reachable"
                : `shadowed: status ${res.statusCode}`,
            ),
          );
        },
      );
      req.on("error", (e) => resolve(`error: ${e.message}`));
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) {
      resolve(`error: ${(e as Error).message}`);
    }
  });
}

// Assets. The HTML comes from the built @nestrix/ui package; the binary is
// random bytes, gzipped once, served with Content-Encoding: gzip.
export const indexHtml: Buffer = readFileSync(
  new URL("index.html", dashboardDirectory),
);
export const blobRaw: Buffer = randomBytes(64 * 1024);
export const blobGz: Buffer = gzipSync(blobRaw);
export const IMMUTABLE = "public, max-age=31536000, immutable";

export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";

type Raw = { req: IncomingMessage; res: ServerResponse };

/** The Node request/response under any adapter: Fastify wraps them (`.raw`). */
export function rawOf(req: unknown, res: unknown): Raw {
  const r = (req ?? {}) as { raw?: unknown };
  const s = (res ?? {}) as { raw?: unknown };
  return {
    req: (r.raw instanceof IncomingMessage ? r.raw : req) as IncomingMessage,
    res: (s.raw instanceof ServerResponse ? s.raw : res) as ServerResponse,
  };
}

function stripCorsHeaders(
  res: unknown,
  raw: ServerResponse,
  rawOnly: boolean,
): void {
  for (const name of raw.getHeaderNames()) {
    if (name.startsWith("access-control-")) raw.removeHeader(name);
  }
  // Fastify keeps its own header map on the reply and merges it over the raw one.
  const reply = res as {
    getHeaders?: () => Record<string, unknown>;
    removeHeader?: (n: string) => void;
  };
  if (
    !rawOnly &&
    typeof reply.getHeaders === "function" &&
    typeof reply.removeHeader === "function" &&
    !(res instanceof ServerResponse)
  ) {
    for (const name of Object.keys(reply.getHeaders())) {
      if (name.toLowerCase().startsWith("access-control-"))
        reply.removeHeader(name);
    }
  }
}

/** On Fastify, tell it we write the raw response ourselves; no-op elsewhere. */
export function takeOver(res: unknown): void {
  const reply = res as { hijack?: () => void; sent?: boolean };
  if (
    !(res instanceof ServerResponse) &&
    typeof reply.hijack === "function" &&
    !reply.sent
  )
    reply.hijack();
}

interface Body {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string | object;
}

function send(
  adapter: AbstractHttpAdapter,
  strategy: WriteStrategy,
  req: unknown,
  res: unknown,
  out: Body,
  stripCors: boolean | "raw-only",
): void {
  const raw = rawOf(req, res);
  // The raw strategy stripped in the route wrapper, before any work.
  if (stripCors && strategy !== "raw")
    stripCorsHeaders(res, raw.res, stripCors === "raw-only");
  const headers = {
    "x-robots-tag": "noindex",
    "content-security-policy": DASHBOARD_CSP,
    ...out.headers,
  };
  if (strategy === "adapter") {
    adapter.status(res, out.status);
    for (const [k, v] of Object.entries(headers)) adapter.setHeader(res, k, v);
    adapter.reply(res, out.body);
    return;
  }
  if (strategy === "adapter-end") {
    adapter.status(res, out.status);
    for (const [k, v] of Object.entries(headers)) adapter.setHeader(res, k, v);
    const body =
      typeof out.body === "string" || Buffer.isBuffer(out.body)
        ? out.body
        : JSON.stringify(out.body);
    adapter.end(res, body as string);
    return;
  }
  // raw: the route wrapper already hijacked (Fastify) and stripped CORS.
  const payload =
    typeof out.body === "string" || Buffer.isBuffer(out.body)
      ? out.body
      : JSON.stringify(out.body);
  raw.res.statusCode = out.status;
  for (const [k, v] of Object.entries(headers)) raw.res.setHeader(k, v);
  if (!raw.res.hasHeader("content-type") && !Buffer.isBuffer(payload))
    raw.res.setHeader("content-type", "application/json; charset=utf-8");
  raw.res.setHeader("content-length", Buffer.byteLength(payload));
  raw.res.end(payload);
}

/** Forwarding headers whose presence disables `ui: 'auto'` (review item 2). */
export const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackAddress(a: string | undefined): boolean {
  if (!a) return false;
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * The per-request half of D-30, read from the raw socket and raw headers only.
 * A candidate, written to test what such a rule can and cannot see.
 */
export function isLocalRequest(raw: IncomingMessage): boolean {
  if (!isLoopbackAddress(raw.socket?.remoteAddress)) return false;
  const host = raw.headers.host;
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  if (!LOOPBACK_HOSTS.has(name.toLowerCase())) return false;
  return !FORWARDING_HEADERS.some((h) => raw.headers[h] !== undefined);
}

/** What the handler can see of the request (Q7). */
export function describeRequest(adapter: AbstractHttpAdapter, req: unknown) {
  const raw = rawOf(req, undefined).req;
  const r = req as { ip?: unknown; hostname?: unknown; ips?: unknown };
  let adapterHostname: unknown;
  try {
    adapterHostname = adapter.getRequestHostname(req);
  } catch (e) {
    adapterHostname = `throws: ${(e as Error).message}`;
  }
  return {
    reqClass: (req as object).constructor?.name,
    reqIsIncomingMessage: req instanceof IncomingMessage,
    hasRaw: (req as { raw?: unknown }).raw instanceof IncomingMessage,
    socketRemoteAddress: raw.socket?.remoteAddress ?? null,
    socketRemoteFamily: raw.socket?.remoteFamily ?? null,
    socketLocalAddress: raw.socket?.localAddress ?? null,
    hostHeader: raw.headers.host ?? null,
    xForwardedFor: raw.headers["x-forwarded-for"] ?? null,
    forwarded: raw.headers.forwarded ?? null,
    secFetchSite: raw.headers["sec-fetch-site"] ?? null,
    xForwardedHost: raw.headers["x-forwarded-host"] ?? null,
    xRealIp: raw.headers["x-real-ip"] ?? null,
    via: raw.headers.via ?? null,
    localByRule: isLocalRequest(raw),
    httpVersion: raw.httpVersion,
    adapterHostname: adapterHostname ?? null,
    reqIp: r.ip ?? null,
    reqIps: r.ips ?? null,
    adapterUrl: adapter.getRequestUrl(req),
  };
}

@Injectable()
export class DashboardMount implements OnModuleInit {
  constructor(
    private readonly host: HttpAdapterHost,
    @Inject(MOUNT_OPTIONS) private readonly options: MountOptions,
  ) {
    try {
      probe.adapterAtConstruction = !!host.httpAdapter;
      if (options.when === "constructor") this.register("constructor");
      if (options.when === "init$") {
        // ReplaySubject: fires now if the adapter is already set, else when it is.
        host.init$.subscribe(() => {
          try {
            this.register("init$");
          } catch (e) {
            probe.registrationErrors.push(`init$: ${(e as Error).message}`);
          }
        });
      }
      if (options.passive) {
        host.init$.subscribe(() => {
          try {
            installPassive(host.httpAdapter, options.base ?? "/_nestrix");
          } catch (e) {
            probe.registrationErrors.push(`passive: ${(e as Error).message}`);
          }
        });
      }
      if (options.selfProbe) {
        probe.selfProbe = new Promise((resolve) => {
          host.listen$.subscribe(() => {
            runSelfProbe(host.httpAdapter, options.base ?? "/_nestrix").then(
              resolve,
            );
          });
        });
      }
    } catch (e) {
      probe.registrationErrors.push(`constructor: ${(e as Error).message}`);
    }
  }

  onModuleInit(): void {
    try {
      probe.adapterAtInit = !!this.host.httpAdapter;
      if (this.options.when === "init") this.register("init");
    } catch (e) {
      probe.registrationErrors.push(`init: ${(e as Error).message}`);
    }
  }

  private register(phase: string): void {
    const adapter = this.host.httpAdapter;
    if (!adapter) {
      probe.registrationErrors.push(`${phase}: no http adapter`);
      return;
    }
    probe.order.push(`dashboard:${phase}`);
    const base = this.options.base ?? "/_nestrix";
    const { strategy } = this.options;
    const stripCors = this.options.stripCors ?? false;
    const route = (
      path: string,
      fn: (req: unknown, res: unknown) => Body,
    ): void => {
      adapter.get(`${base}${path}`, (req: unknown, res: unknown) => {
        // Rule 1: nothing thrown here may reach the host's error handling.
        try {
          // First, before any work: take over the response (Fastify) and drop
          // what host CORS put on it, so that every exit path, the error path
          // included, writes a response with no allow headers.
          if (strategy === "raw") {
            takeOver(res);
            if (stripCors)
              stripCorsHeaders(
                res,
                rawOf(req, res).res,
                stripCors === "raw-only",
              );
          }
          probe.hits++;
          const ps = passiveAls.getStore();
          if (ps) ps.reached = true;
          send(adapter, strategy, req, res, fn(req, res), stripCors);
        } catch (e) {
          probe.handlerErrors.push((e as Error).stack ?? String(e));
          try {
            takeOver(res);
            const raw = rawOf(req, res).res;
            if (stripCors) stripCorsHeaders(res, raw, false);
            if (!raw.headersSent) {
              raw.statusCode = 500;
              raw.setHeader("content-length", 0);
              raw.end();
            }
          } catch {
            // nothing left to do
          }
        }
      });
      probe.registered.push(`${base}${path}`);
    };

    route("/api/whoami", (req) => ({
      status: 200,
      headers: { "cache-control": "no-store" },
      body: { ok: true, request: describeRequest(adapter, req) },
    }));
    route("/api/fails", () => {
      throw new Error("dashboard work failed");
    });
    route("/api/big", () => ({
      status: 200,
      headers: { "cache-control": "no-store" },
      body: {
        rows: Array.from({ length: 400 }, (_, i) => ({ i, s: "x".repeat(20) })),
      },
    }));
    route("/api/probe", (req) => {
      const nonce = rawOf(req, undefined).req.headers["x-nestrix-probe"];
      if (typeof nonce === "string") probe.nonces.push(nonce);
      return {
        status: 204,
        headers: { "cache-control": "no-store" },
        body: "",
      };
    });
    route("/index.html", () => ({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: indexHtml,
    }));
    route("/assets/blob.bin", () => ({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "cache-control": IMMUTABLE,
        vary: "Accept-Encoding",
      },
      body: blobGz,
    }));
    // Deliberately unguarded: shows who handles an exception that escapes a
    // handler registered through httpAdapter.get (and so why ours must not).
    adapter.get(`${base}/api/throws`, () => {
      throw new Error("dashboard handler threw");
    });
    probe.registered.push(`${base}/api/throws`);
    // Same, rejecting asynchronously.
    adapter.get(`${base}/api/throws-async`, async () => {
      await null;
      throw new Error("dashboard handler rejected");
    });
    probe.registered.push(`${base}/api/throws-async`);
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: the Nest dynamic-module pattern
export class DashboardModule {
  static register(options: MountOptions): DynamicModule {
    return {
      module: DashboardModule,
      providers: [
        { provide: MOUNT_OPTIONS, useValue: options },
        DashboardMount,
      ],
    };
  }
}
