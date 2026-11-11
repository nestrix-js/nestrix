// Global state: a host tracer provider (bootApp's in-memory exporter), an ALS context manager
// and a W3C propagator, registered before Nestrix. Nestrix uses the host's SDK.
// P1-06 and P1-07 on Express, Fastify and platform-node through NestFactory.create.
import { setTimeout as sleep } from "node:timers/promises";
import { type VersioningOptions, VersioningType } from "@nestjs/common";
import { type BootedApp, bootApp, type ReadableSpan } from "@nestrix/testing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import {
  ADAPTERS,
  BIG_BODY_BYTES,
  HostController,
  rawExchange,
  rawRequest,
  registerHostContext,
  rootModule,
  serverSpan,
  serverSpans,
  TestController,
  V1Controller,
  V2Controller,
} from "./http-fixture.js";

registerHostContext();

let booted: BootedApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});
beforeEach(() => resetDiagnosticsForTests());

const exceptionEvents = (s: ReadableSpan) =>
  s.events.filter((e) => e.name === "exception");

describe.each(ADAPTERS)("HTTP server spans on %s", (adapter) => {
  describe("default app", () => {
    async function boot(): Promise<BootedApp> {
      booted = await bootApp(adapter, { module: rootModule([TestController]) });
      return booted;
    }

    it("names a matched route by its template, with the semconv attributes", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/users/42?token=abc&x=1`, {
        headers: {
          "x-request-id": "req-1",
          "x-extra": "extra",
          "x-not-listed": "secret",
          authorization: "Bearer secret",
          "user-agent": "nestrix-test",
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "42" });
      const span = await serverSpan(app, "/users/42");
      expect(span.name).toBe("GET /users/:id");
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes).toMatchObject({
        "http.request.method": "GET",
        "http.route": "/users/:id",
        "http.response.status_code": 200,
        "url.path": "/users/42",
        "url.query": "token=REDACTED&x=1",
        "url.scheme": "http",
        "network.protocol.version": "1.1",
        "user_agent.original": "nestrix-test",
        "code.function.name": "AppController.user",
        "http.request.header.x-request-id": ["req-1"],
        "http.request.header.x-extra": ["extra"],
      });
      if (adapter === "node") {
        // Known limit: platform-node's writeBody passes Content-Type and Content-Length to
        // writeHead(status, headers), which getHeaders() does not reflect. Pinned so a change
        // in Nest shows up here.
        expect(
          span.attributes["http.response.header.content-type"],
        ).toBeUndefined();
      } else {
        expect(span.attributes["http.response.header.content-type"]).toEqual([
          expect.stringContaining("application/json"),
        ]);
      }
      expect(
        span.attributes["http.request.header.x-not-listed"],
      ).toBeUndefined();
      expect(
        span.attributes["http.request.header.authorization"],
      ).toBeUndefined();
      expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
      expect(exceptionEvents(span)).toHaveLength(0);
    });

    it("continues an incoming traceparent", async () => {
      const app = await boot();
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";
      await fetch(`${app.baseUrl}/hello`, {
        headers: { traceparent: `00-${traceId}-${parentId}-01` },
      });
      const span = await serverSpan(app, "/hello");
      expect(span.spanContext().traceId).toBe(traceId);
      expect(span.parentSpanContext?.spanId).toBe(parentId);
    });

    it("names an unmatched request by method only (404)", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/nowhere/at/all`);
      expect(res.status).toBe(404);
      const span = await serverSpan(app, "/nowhere/at/all");
      expect(span.name).toBe("GET");
      expect(span.attributes["http.route"]).toBeUndefined();
      expect(span.attributes["http.response.status_code"]).toBe(404);
      expect(span.attributes["code.function.name"]).toBeUndefined();
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("keeps the route of a guard rejection (403), records no exception", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/private`);
      expect(res.status).toBe(403);
      const span = await serverSpan(app, "/private");
      expect(span.name).toBe("GET /private");
      expect(span.attributes["http.route"]).toBe("/private");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(exceptionEvents(span)).toHaveLength(0);
      expect(span.attributes["code.function.name"]).toBeUndefined();
    });

    it("records a handler error as an exception with error status (500)", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/boom`);
      expect(res.status).toBe(500);
      const span = await serverSpan(app, "/boom");
      expect(span.name).toBe("GET /boom");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("Error");
      const [event] = exceptionEvents(span);
      expect(event?.attributes).toMatchObject({
        "exception.type": "Error",
        "exception.message": "boom",
      });
    });

    it("records an HttpException below 500 as an event, status unset (418)", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/teapot`);
      expect(res.status).toBe(418);
      const span = await serverSpan(app, "/teapot");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes["error.type"]).toBeUndefined();
      expect(exceptionEvents(span)).toHaveLength(1);
      expect(exceptionEvents(span)[0]?.attributes?.["exception.type"]).toBe(
        "HttpException",
      );
    });

    it("records a pipe's exception (400), status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/parse/abc`);
      expect(res.status).toBe(400);
      const span = await serverSpan(app, "/t/parse/abc");
      expect(span.name).toBe("GET /t/parse/:n");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(exceptionEvents(span)[0]?.attributes?.["exception.type"]).toBe(
        "BadRequestException",
      );
    });

    it("records an error a filter turned into a 200, status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/filtered`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handled: true });
      const span = await serverSpan(app, "/t/filtered");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(exceptionEvents(span)[0]?.attributes?.["exception.message"]).toBe(
        "turned into a 200",
      );
    });

    it("records a thrown non-Error value (500)", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/thrown-string`);
      expect(res.status).toBe(500);
      const span = await serverSpan(app, "/t/thrown-string");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("_OTHER");
      expect(exceptionEvents(span)[0]?.attributes?.["exception.message"]).toBe(
        "a plain string",
      );
    });

    it("parents a span created in the handler (POST with a JSON body)", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/child`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(await res.json()).toEqual({ a: 1 });
      const span = await serverSpan(app, "/t/child");
      const child = await app.waitForSpan("handler.child");
      expect(child.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
    });

    it("ends a streamed response when the stream closes", async () => {
      const app = await boot();
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/stream`);
      expect(await res.text()).toBe("chunk 1\nchunk 2\nchunk 3\nchunk 4\n");
      const span = await serverSpan(app, "/stream");
      const ms = span.duration[0] * 1000 + span.duration[1] / 1e6;
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(ms).toBeLessThanOrEqual(Date.now() - started + 50);
      expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
    });

    it("marks a client abort mid-stream, keeping the sent status", async () => {
      const app = await boot();
      await rawRequest(app.baseUrl, "/stream", { destroyOnFirstData: true });
      const span = await serverSpan(app, "/stream");
      expect(span.attributes["nestrix.http.aborted"]).toBe(true);
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("marks an abort before any response, with no status code", async () => {
      const app = await boot();
      await rawRequest(app.baseUrl, "/t/slow", { destroyAfterMs: 50 });
      const span = await serverSpan(app, "/t/slow");
      expect(span.attributes["nestrix.http.aborted"]).toBe(true);
      expect(span.attributes["http.response.status_code"]).toBeUndefined();
      expect(span.name).toBe("GET /t/slow");
    });

    it(`marks a delivery cut after the app ended the response (Node ${process.version})`, async () => {
      const app = await boot();
      await rawRequest(app.baseUrl, "/t/big", { destroyOnFirstData: true });
      const span = await serverSpan(app, "/t/big");
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.attributes["nestrix.http.aborted"]).toBe(true);
    });

    it("does not mark a large response read in full, keep-alive or Connection: close", async () => {
      const app = await boot();
      const keepAlive = await fetch(`${app.baseUrl}/t/big`);
      expect((await keepAlive.text()).length).toBe(BIG_BODY_BYTES);
      const close = await fetch(`${app.baseUrl}/t/big`, {
        headers: { connection: "close" },
      });
      expect((await close.text()).length).toBe(BIG_BODY_BYTES);
      await sleep(50);
      const spans = serverSpans(app, "/t/big");
      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
      }
    });

    it("gives an ignored route no span and leaves it working", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/ignored`);
      expect(await res.text()).toBe("ignored");
      await fetch(`${app.baseUrl}/hello`);
      await serverSpan(app, "/hello");
      expect(serverSpans(app, "/t/ignored")).toHaveLength(0);
    });

    it("keeps the first segment of a target starting with //", async () => {
      const app = await boot();
      await rawRequest(app.baseUrl, "//double/slash?code=1");
      const span = await serverSpan(app, "//double/slash");
      expect(span.attributes["url.query"]).toBe("code=REDACTED");
    });

    it("records no request or response body content, and counts no failure", async () => {
      const app = await boot();
      const secret = "hunter2-in-the-body";
      const res = await fetch(`${app.baseUrl}/t/child`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: secret }),
      });
      expect(await res.text()).toContain(secret); // echoed back in the response body
      const span = await serverSpan(app, "/t/child");
      const values = JSON.stringify([span.attributes, span.events, span.name]);
      expect(values).not.toContain(secret);
      expect([...getFailureCounts().keys()]).toEqual([]);
    });

    const BIG = Buffer.alloc(4 * 1024 * 1024, 97);
    const sink = (c: string, length: number) =>
      `POST /t/sink/${c} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`;
    const NOT_ABORTED: {
      name: string;
      paths: string[];
      payload: string | (string | Buffer)[];
      options?: { endAfterWrite?: boolean; closeAfterMs?: number };
    }[] = [
      {
        name: "HTTP/1.0",
        paths: ["/users/h10"],
        payload: "GET /users/h10 HTTP/1.0\r\n\r\n",
      },
      {
        name: "HTTP/1.0 keep-alive",
        paths: ["/users/h10ka"],
        payload: "GET /users/h10ka HTTP/1.0\r\nConnection: keep-alive\r\n\r\n",
      },
      {
        name: "three pipelined requests",
        paths: ["/users/p1", "/users/p2", "/users/p3"],
        payload:
          "GET /users/p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /users/p2 HTTP/1.1\r\nHost: x\r\n\r\nGET /users/p3 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      },
      {
        name: "client half-close after the request",
        paths: ["/users/half"],
        payload: "GET /users/half HTTP/1.1\r\nHost: x\r\n\r\n",
        options: { endAfterWrite: true },
      },
      {
        name: "HTTP/1.0 with half-close",
        paths: ["/users/half10"],
        payload: "GET /users/half10 HTTP/1.0\r\n\r\n",
        options: { endAfterWrite: true },
      },
      {
        name: "4 MiB request body left unread, sent fully",
        paths: ["/t/sink/full"],
        payload: [sink("full", BIG.length), BIG],
        options: { closeAfterMs: 1500 },
      },
      {
        name: "4 MiB request body left unread, sent partly",
        paths: ["/t/sink/part"],
        payload: [sink("part", BIG.length), BIG.subarray(0, 1000)],
        options: { closeAfterMs: 800 },
      },
      {
        name: "Upgrade: websocket to a normal route",
        paths: ["/users/upgrade"],
        payload:
          "GET /users/upgrade HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      },
      {
        name: "HEAD",
        paths: ["/users/head"],
        payload:
          "HEAD /users/head HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      },
      {
        name: "Expect: 100-continue",
        paths: ["/t/sink/expect"],
        payload: [
          "POST /t/sink/expect HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n",
          "hello",
        ],
      },
    ];

    it.each(NOT_ABORTED)(
      `does not mark as aborted: $name (Node ${process.version})`,
      async ({ paths, payload, options }) => {
        const app = await boot();
        const received = await rawExchange(app.baseUrl, payload, options);
        expect(received).toMatch(/^HTTP\/1\.1 \d{3}/);
        for (const path of paths) {
          const span = await serverSpan(app, path);
          expect(span.attributes["http.response.status_code"]).toEqual(
            expect.any(Number),
          );
          expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
        }
      },
    );
  });

  it("ignores a request whose ignore matcher throws, counts it, and serves it unchanged", async () => {
    booted = await bootApp(adapter, {
      module: rootModule([], {
        export: { otlp: false },
        ignore: {
          routes: [
            (path) => {
              if (path === "/hello") throw new Error("user matcher");
              return false;
            },
          ],
        },
      }),
    });
    const res = await fetch(`${booted.baseUrl}/hello`);
    expect(await res.text()).toBe("hello");
    await fetch(`${booted.baseUrl}/users/1`);
    await serverSpan(booted, "/users/1");
    expect(serverSpans(booted, "/hello")).toHaveLength(0);
    expect(getFailureCounts().get("http.ignore-routes")).toBe(1);
  });

  it("composes the global prefix and URI version into the route", async () => {
    booted = await bootApp(adapter, {
      module: rootModule([V1Controller, V2Controller]),
      configure: (app) => {
        app.setGlobalPrefix("api");
        app.enableVersioning({ type: VersioningType.URI });
      },
    });
    const res = await fetch(`${booted.baseUrl}/api/v2/ver/7`);
    expect(await res.text()).toBe("v2:7");
    const span = await serverSpan(booted, "/api/v2/ver/7");
    expect(span.name).toBe("GET /api/v2/ver/:id");
    expect(span.attributes["http.route"]).toBe("/api/v2/ver/:id");
    expect(span.attributes["code.function.name"]).toBe("V2Controller.two");
    // An unversioned fixture route under the prefix.
    await fetch(`${booted.baseUrl}/api/users/1`);
    expect((await serverSpan(booted, "/api/users/1")).name).toBe(
      "GET /api/users/:id",
    );
  });

  describe.each([
    {
      kind: "header",
      versioning: {
        type: VersioningType.HEADER,
        header: "x-api-version",
      } as const,
      v1: { "x-api-version": "1" } as Record<string, string>,
      v2: { "x-api-version": "2" } as Record<string, string>,
      none: {} as Record<string, string>,
    },
    {
      kind: "media type",
      versioning: { type: VersioningType.MEDIA_TYPE, key: "v=" } as const,
      v1: { accept: "application/json;v=1" } as Record<string, string>,
      v2: { accept: "application/json;v=2" } as Record<string, string>,
      none: { accept: "application/json" } as Record<string, string>,
    },
    {
      kind: "custom",
      versioning: {
        type: VersioningType.CUSTOM,
        extractor: (req: unknown) => {
          const r = req as { headers: Record<string, string | undefined> };
          return r.headers["x-custom"] ?? "";
        },
      } as const,
      v1: { "x-custom": "1" } as Record<string, string>,
      v2: { "x-custom": "2" } as Record<string, string>,
      none: {} as Record<string, string>,
    },
  ])(
    "$kind versioning, two versions of one route",
    ({ versioning, v1, v2, none }) => {
      it("names the handler that accepted, and drops the route on a 404 no version accepted", async () => {
        booted = await bootApp(adapter, {
          module: rootModule([V1Controller, V2Controller], undefined, false),
          configure: (app) =>
            app.enableVersioning(versioning as VersioningOptions),
        });
        const r2 = await fetch(`${booted.baseUrl}/ver/a`, {
          headers: v2 as Record<string, string>,
        });
        expect(await r2.text()).toBe("v2:a");
        const r1 = await fetch(`${booted.baseUrl}/ver/b`, {
          headers: v1 as Record<string, string>,
        });
        expect(await r1.text()).toBe("v1:b");
        const r0 = await fetch(`${booted.baseUrl}/ver/c`, {
          headers: none as Record<string, string>,
        });
        expect(r0.status).toBe(404);

        const s2 = await serverSpan(booted, "/ver/a");
        expect(s2.name).toBe("GET /ver/:id");
        expect(s2.attributes["code.function.name"]).toBe("V2Controller.two");
        const s1 = await serverSpan(booted, "/ver/b");
        expect(s1.attributes["code.function.name"]).toBe("V1Controller.one");
        const s0 = await serverSpan(booted, "/ver/c");
        expect(s0.name).toBe("GET");
        expect(s0.attributes["http.route"]).toBeUndefined();
        expect(s0.attributes["http.response.status_code"]).toBe(404);
      });
    },
  );

  it("drops the route when a host filter declines (404)", async () => {
    booted = await bootApp(adapter, {
      module: rootModule([HostController], undefined, false),
    });
    const accepted = await rawRequest(booted.baseUrl, "/admin", {
      headers: { host: "admin.example.com" },
    });
    const declined = await rawRequest(booted.baseUrl, "/admin?x", {
      headers: { host: "other.example.com" },
    });
    const statusOf = (raw: string) => Number(raw.split(" ")[1]);
    expect(statusOf(accepted)).toBe(200);
    expect(statusOf(declined)).toBe(404);
    const spans = serverSpans(booted, "/admin");
    await sleep(20);
    const ok = spans.find(
      (s) => s.attributes["http.response.status_code"] === 200,
    );
    const notFound = serverSpans(booted, "/admin").find(
      (s) => s.attributes["http.response.status_code"] === 404,
    );
    expect(ok?.name).toBe("GET /admin");
    expect(notFound?.name).toBe("GET");
    expect(notFound?.attributes["http.route"]).toBeUndefined();
  });
});
