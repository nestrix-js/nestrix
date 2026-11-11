// P7-02: the profiler's start route is the dashboard's first state-changing request
// (architecture §4.7, "Starting a CPU capture"). One test per rule, on Express, Fastify and
// platform-node, against a listening server with permissive host CORS, over raw TCP so every
// header byte is the test's.
//
// Method: each refusal differs from the accepted control in exactly the variable under test, and
// asserts that no capture started (the process-wide slot is empty) and that the answer carries no
// CORS header.
//
// Global state: Nestrix owns the provider (export off); the process-wide profiler slot is reset
// after each test (a started capture is discarded, never kept).
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardFaults } from "../src/dashboard/mount.js";
import {
  checkStartHeaders,
  isOwnOrigin,
  readStartBody,
} from "../src/dashboard/profiles.js";
import { getProcessStartupToken } from "../src/dashboard/startup-token.js";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import {
  resetProfilerForTests,
  runningCapture,
} from "../src/profiler/profiler.js";
import {
  ADAPTERS,
  bootDashboardApp,
  type DashboardApp,
  EVIL_ORIGIN,
  get,
  TOKEN,
} from "./dashboard-fixture.js";
import { type RawReply, rawRequest } from "./dashboard-security-fixture.js";

const BASE = { export: { otlp: false as const } };
const ENABLED = { ...BASE, ui: { enabled: true, auth: { token: TOKEN } } };
const PATH = "/_nestrix";
const PROFILES = `${PATH}/api/v1/profiles`;
const BODY = JSON.stringify({ durationSeconds: 1 });

let booted: DashboardApp | undefined;

beforeEach(() => {
  resetDiagnosticsForTests();
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetProfilerForTests();
  await booted?.close();
  booted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function boot(
  adapter: (typeof ADAPTERS)[number],
  nestrix: Record<string, unknown>,
): Promise<DashboardApp> {
  booted = await bootDashboardApp({ adapter, nestrix, cors: true });
  return booted;
}

interface StartRequest {
  /** Header lines, in order; `Host` is not added. */
  headers: string[];
  body?: string;
  /** Leave out `Content-Length` and send the body chunked. */
  chunked?: boolean;
  path?: string;
}

/** A POST written verbatim, with `Content-Length` from the body unless `chunked`. */
function post(app: DashboardApp, r: StartRequest): Promise<RawReply> {
  const body = r.body ?? BODY;
  const framing = r.chunked
    ? [`Transfer-Encoding: chunked`]
    : [`Content-Length: ${Buffer.byteLength(body)}`];
  const payload = r.chunked
    ? `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
    : body;
  const text = `POST ${r.path ?? PROFILES} HTTP/1.1\r\n${[...r.headers, ...framing].join("\r\n")}\r\nConnection: close\r\n\r\n${payload}`;
  return rawRequest(app.port, text);
}

/** What the dashboard page's `fetch` sends: same origin, JSON, the bearer token in enabled mode. */
function pageHeaders(
  app: DashboardApp,
  over: Partial<Record<string, string | null>> = {},
): string[] {
  const host = `127.0.0.1:${app.port}`;
  const all: Record<string, string | null> = {
    Host: host,
    Origin: `http://${host}`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
    ...over,
  };
  return Object.entries(all)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([k, v]) => `${k}: ${v}`);
}

function cors(r: RawReply): string[] {
  return Object.keys(r.headers).filter((k) => k.startsWith("access-control-"));
}

function errorCode(r: RawReply): string | undefined {
  try {
    return (JSON.parse(r.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/** Refused, nothing started, no CORS header. */
function expectRefused(r: RawReply, status: number, code?: string): void {
  expect(r.status, r.body).toBe(status);
  if (code !== undefined) expect(errorCode(r)).toBe(code);
  expect(runningCapture()).toBeNull();
  expect(cors(r)).toEqual([]);
}

describe("start rules without a server", () => {
  it("isOwnOrigin: host and port must match; TLS needs https; default ports are ignored", () => {
    expect(isOwnOrigin("http://app.example", "app.example", false)).toBe(true);
    expect(isOwnOrigin("HTTP://App.Example:80", "app.example", false)).toBe(
      true,
    );
    // Behind a TLS-terminating proxy that forwards the original Host.
    expect(isOwnOrigin("https://app.example", "app.example", false)).toBe(true);
    expect(isOwnOrigin("https://app.example:443", "app.example", true)).toBe(
      true,
    );
    expect(isOwnOrigin("http://app.example", "app.example", true)).toBe(false);
    expect(isOwnOrigin("http://app.example:8080", "app.example", false)).toBe(
      false,
    );
    expect(isOwnOrigin("http://evil.example", "app.example", false)).toBe(
      false,
    );
    expect(isOwnOrigin("http://app.example/", "app.example", false)).toBe(
      false,
    );
    expect(
      isOwnOrigin("http://user@app.example", "user@app.example", false),
    ).toBe(false);
    expect(isOwnOrigin("null", "app.example", false)).toBe(false);
    expect(isOwnOrigin(undefined, "app.example", false)).toBe(false);
    expect(isOwnOrigin("http://app.example", undefined, false)).toBe(false);
  });

  it("checkStartHeaders refuses an unreadable request and never throws", () => {
    expect(checkStartHeaders(undefined)?.status).toBe(403);
    const hostile = {
      get headers(): never {
        throw new Error("boom");
      },
    };
    expect(checkStartHeaders(hostile as never)?.status).toBe(403);
  });

  it("readStartBody: a host-parsed text body is re-parsed and capped; a consumed stream is refused", async () => {
    expect(await readStartBody({ body: '{"durationSeconds":2}' }, {})).toEqual({
      ok: true,
      value: { durationSeconds: 2 },
    });
    const big = await readStartBody({ body: Buffer.alloc(2000, 32) }, {});
    expect(big.ok).toBe(false);
    const consumed = await readStartBody(
      {},
      { readableEnded: true, on() {}, removeListener() {} },
    );
    expect(consumed.ok).toBe(false);
  });

  it("readStartBody gives up on a stream that never ends (timeout) and one that errors", async () => {
    const listeners: Record<string, (...a: unknown[]) => void> = {};
    const stalled = {
      on(event: string, fn: (...a: unknown[]) => void) {
        listeners[event] = fn;
      },
      removeListener() {},
    };
    const pending = readStartBody({}, stalled, 20);
    listeners.data?.(Buffer.from("{"));
    expect((await pending).ok).toBe(false);
    const erroring = readStartBody({}, stalled, 1000);
    listeners.error?.(new Error("reset"));
    expect((await erroring).ok).toBe(false);
  });
});

describe.each(ADAPTERS)("profiler start route on %s", (adapter) => {
  it("accepts the dashboard page's request: 202 with the measured start pause; a second start is 409", async () => {
    const app = await boot(adapter, ENABLED);
    const r = await post(app, { headers: pageHeaders(app) });
    expect(r.status, r.body).toBe(202);
    expect(cors(r)).toEqual([]);
    expect(r.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    const started = JSON.parse(r.body) as {
      id: string;
      durationMs: number;
      startPauseMs: number;
    };
    expect(started.id).toMatch(/^[0-9a-f]{16}$/);
    expect(started.durationMs).toBe(1000);
    expect(started.startPauseMs).toBeGreaterThanOrEqual(0);
    expect(runningCapture()?.id).toBe(started.id);

    const again = await post(app, { headers: pageHeaders(app) });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe("conflict");
    expect(
      (JSON.parse(again.body) as { running: { id: string } }).running.id,
    ).toBe(started.id);
    expect(cors(again)).toEqual([]);

    const meta = await get(`${app.baseUrl}${PATH}/api/v1/meta`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect((meta.json() as { profiler: unknown }).profiler).toEqual({
      available: true,
      running: true,
    });
    const list = await get(`${app.baseUrl}${PROFILES}`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(list.status).toBe(200);
    expect((list.json() as { running: { id: string } }).running.id).toBe(
      started.id,
    );
  });

  it("refuses Sec-Fetch-Site: cross-site with the bare 404 of a denied request", async () => {
    const app = await boot(adapter, ENABLED);
    const r = await post(app, {
      headers: pageHeaders(app, { "Sec-Fetch-Site": "cross-site" }),
    });
    expectRefused(r, 404);
    expect(r.body).toBe("");
    expect(r.headers["content-security-policy"]).toBeUndefined();
  });

  it("refuses Sec-Fetch-Site: same-site (another port of the same host) and none at all", async () => {
    const app = await boot(adapter, ENABLED);
    expectRefused(
      await post(app, {
        headers: pageHeaders(app, { "Sec-Fetch-Site": "same-site" }),
      }),
      403,
      "forbidden",
    );
    expectRefused(
      await post(app, {
        headers: pageHeaders(app, { "Sec-Fetch-Site": "none" }),
      }),
      403,
      "forbidden",
    );
    expectRefused(
      await post(app, {
        headers: pageHeaders(app, { "Sec-Fetch-Site": null }),
      }),
      403,
      "forbidden",
    );
  });

  it("refuses a missing, foreign, other-port, null or repeated Origin", async () => {
    const app = await boot(adapter, ENABLED);
    for (const origin of [
      null,
      EVIL_ORIGIN,
      `http://127.0.0.1:${app.port + 1}`,
      "null",
      `http://127.0.0.1:${app.port}.evil.example`,
    ]) {
      expectRefused(
        await post(app, { headers: pageHeaders(app, { Origin: origin }) }),
        403,
        "forbidden",
      );
    }
    expectRefused(
      await post(app, {
        headers: [...pageHeaders(app), `Origin: ${EVIL_ORIGIN}`],
      }),
      403,
      "forbidden",
    );
  });

  it("refuses a request without dashboard access (no bearer token) with the bare 404", async () => {
    const app = await boot(adapter, ENABLED);
    const r = await post(app, {
      headers: pageHeaders(app, { Authorization: null }),
    });
    expectRefused(r, 404);
    expect(r.body).toBe("");
  });

  it("refuses a body that is not application/json (415)", async () => {
    const app = await boot(adapter, ENABLED);
    expectRefused(
      await post(app, {
        headers: pageHeaders(app, { "Content-Type": "text/plain" }),
      }),
      415,
      "unsupported_media_type",
    );
  });

  it("refuses a body over 1,024 bytes (413) and one without Content-Length (411)", async () => {
    const app = await boot(adapter, ENABLED);
    const big = JSON.stringify({ durationSeconds: 1, pad: "x".repeat(2048) });
    expectRefused(
      await post(app, { headers: pageHeaders(app), body: big }),
      413,
      "payload_too_large",
    );
    expectRefused(
      await post(app, { headers: pageHeaders(app), chunked: true }),
      411,
      "length_required",
    );
  });

  it("refuses unknown fields, out-of-range durations and unknown query parameters (400)", async () => {
    const app = await boot(adapter, ENABLED);
    for (const body of [
      JSON.stringify({ durationSeconds: 121 }),
      JSON.stringify({ durationSeconds: 0 }),
      JSON.stringify({ durationSeconds: 1.5 }),
      JSON.stringify({ durationSeconds: "5" }),
      JSON.stringify({ durationSeconds: 1, extra: true }),
      JSON.stringify([1]),
    ]) {
      expectRefused(
        await post(app, { headers: pageHeaders(app), body }),
        400,
        "bad_request",
      );
    }
    expectRefused(
      await post(app, {
        headers: pageHeaders(app),
        path: `${PROFILES}?durationSeconds=5`,
      }),
      400,
      "bad_request",
    );
  });

  it("answers 404 for an unknown or malformed profile id, without CORS headers", async () => {
    const app = await boot(adapter, ENABLED);
    for (const path of [
      `${PROFILES}/0123456789abcdef`,
      `${PROFILES}/0123456789abcdef/download`,
      `${PROFILES}/not-an-id`,
    ]) {
      const r = await get(`${app.baseUrl}${path}`, {
        authorization: `Bearer ${TOKEN}`,
        origin: EVIL_ORIGIN,
      });
      expect(r.status, path).toBe(404);
      expect(
        [...r.headers.keys()].filter((k) => k.startsWith("access-control-")),
      ).toEqual([]);
    }
  });

  it("'auto' with the startup token: starts with the session cookie; without it, the 403 JSON error", async () => {
    const app = await boot(adapter, BASE);
    const token = getProcessStartupToken().token;
    const exchange = await get(`${app.baseUrl}${PATH}/auth?token=${token}`);
    expect(exchange.status).toBe(303);
    const cookie = (exchange.headers.get("set-cookie") as string).split(";")[0];
    const local = {
      Host: `localhost:${app.port}`,
      Origin: `http://localhost:${app.port}`,
      Authorization: null,
    };
    expectRefused(
      await post(app, { headers: pageHeaders(app, local) }),
      403,
      "forbidden",
    );
    const ok = await post(app, {
      headers: pageHeaders(app, { ...local, Cookie: cookie as string }),
    });
    expect(ok.status, ok.body).toBe(202);
    expect(runningCapture()).not.toBeNull();
  });

  it("'auto' without the startup token or auth: no profiler routes, meta says unavailable", async () => {
    const app = await boot(adapter, { ...BASE, ui: { startupToken: false } });
    const headers = pageHeaders(app, {
      Host: `localhost:${app.port}`,
      Origin: `http://localhost:${app.port}`,
      Authorization: null,
    });
    const r = await post(app, { headers });
    expect(r.status).toBe(404);
    expect(runningCapture()).toBeNull();
    const meta = await rawRequest(
      app.port,
      `GET ${PATH}/api/v1/meta HTTP/1.1\r\nHost: localhost:${app.port}\r\nConnection: close\r\n\r\n`,
    );
    expect(meta.status).toBe(200);
    expect(JSON.parse(meta.body).profiler).toEqual({
      available: false,
      running: false,
    });
  });

  it("ui.profiler: false: no profiler routes, meta says unavailable", async () => {
    const app = await boot(adapter, {
      ...BASE,
      ui: { enabled: true, auth: { token: TOKEN }, profiler: false },
    });
    expect((await post(app, { headers: pageHeaders(app) })).status).toBe(404);
    expect(runningCapture()).toBeNull();
    const list = await get(`${app.baseUrl}${PROFILES}`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(list.status).toBe(404);
    const meta = await get(`${app.baseUrl}${PATH}/api/v1/meta`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect((meta.json() as { profiler: unknown }).profiler).toEqual({
      available: false,
      running: false,
    });
  });

  it("enabled without auth: the dashboard is off, so nothing can start a capture", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const app = await boot(adapter, { ...BASE, ui: { enabled: true } });
    expect((await post(app, { headers: pageHeaders(app) })).status).toBe(404);
    expect(runningCapture()).toBeNull();
  });

  it("with no host body parser (bodyParser: false) reads the raw body itself, within the limit", async () => {
    booted = await bootDashboardApp({
      adapter,
      nestrix: ENABLED,
      cors: true,
      bodyParser: false,
    });
    const app = booted;
    expectRefused(
      await post(app, {
        headers: pageHeaders(app),
        body: JSON.stringify({ durationSeconds: 1, extra: 1 }),
      }),
      400,
      "bad_request",
    );
    const invalid = await post(app, {
      headers: pageHeaders(app),
      body: "{not json",
    });
    if (adapter === "fastify") {
      // Fastify parses JSON whatever `bodyParser` says; its own 400 answers before the route.
      // That answer comes from the host's parser, before the dashboard's access check runs, so
      // it carries the host's CORS headers (`cors: true` above): the CORS assertion of
      // `expectRefused` is skipped here on purpose. The body is Fastify's generic parser
      // message and an unregistered path answers identically, so nothing about the dashboard
      // leaks (architecture section 4.7). The same holds for Fastify's 415 on an unsupported
      // content type, and for the Express and platform-node parsers on malformed JSON.
      expect(invalid.status).toBe(400);
      expect(runningCapture()).toBeNull();
    } else {
      expectRefused(invalid, 400, "bad_request");
    }
    const ok = await post(app, { headers: pageHeaders(app) });
    expect(ok.status, ok.body).toBe(202);
  });

  it("a start within 10 s of the previous capture's end is 429 with Retry-After and retryAfterSeconds", async () => {
    const app = await boot(adapter, ENABLED);
    expect((await post(app, { headers: pageHeaders(app) })).status).toBe(202);
    const deadline = Date.now() + 5000;
    while (runningCapture() !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(runningCapture()).toBeNull();
    const r = await post(app, { headers: pageHeaders(app) });
    expect(r.status, r.body).toBe(429);
    expect(errorCode(r)).toBe("too_many_requests");
    const seconds = (JSON.parse(r.body) as { retryAfterSeconds: number })
      .retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(10);
    expect(r.headers["retry-after"]).toBe(String(seconds));
    expect(cors(r)).toEqual([]);
    expect(runningCapture()).toBeNull();
  });

  it("a fault inside the start handler answers 500 itself and starts nothing", async () => {
    const app = await boot(adapter, ENABLED);
    dashboardFaults.site = "handler";
    try {
      const r = await post(app, { headers: pageHeaders(app) });
      expectRefused(r, 500, "internal");
    } finally {
      dashboardFaults.site = undefined;
    }
    // The app still serves, and the next start works.
    expect((await post(app, { headers: pageHeaders(app) })).status).toBe(202);
  });

  it("app.close() discards a running capture and frees the slot", async () => {
    const app = await boot(adapter, ENABLED);
    const r = await post(app, {
      headers: pageHeaders(app),
      body: JSON.stringify({ durationSeconds: 60 }),
    });
    expect(r.status).toBe(202);
    expect(runningCapture()).not.toBeNull();
    await app.close();
    booted = undefined;
    expect(runningCapture()).toBeNull();
  });
});
