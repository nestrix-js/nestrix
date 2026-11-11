// Phase 1 conformance suite, HTTP rows (docs/roadmap.md, "Conformance suite: expected results").
// One test per table row, named after the row, asserting the expected server span. The feature
// tests (http-server, http-interceptor, http-faults, http-testing) go deeper; this file is the
// table-shaped acceptance check, and the per-version packages (packages/conformance-nest12-*)
// run it unchanged against old Nest releases.
//
// Global state: a host tracer provider (bootApp's in-memory exporter), an ALS context manager and
// a W3C propagator, registered before Nestrix. The rows without an HTTP adapter are in
// conformance-apps.test.ts, which needs the globals unset.
//
// Environment: CONFORMANCE_ADAPTERS (comma list of express, fastify, node; default all) selects the
// adapters, so a Nest release that lacks one can skip it; CONFORMANCE_NEST names the version.
import { Readable } from "node:stream";
import {
  Controller,
  Post,
  Req,
  type VersioningOptions,
  VersioningType,
} from "@nestjs/common";
import {
  type BootedApp,
  bootApp,
  type ReadableSpan,
} from "@nestrix-js/testing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { type FaultSite, faultInjection } from "../src/http/request-state.js";
import { withSpan } from "../src/span.js";
import {
  ADAPTERS,
  rawRequest,
  registerHostContext,
  rootModule,
  serverSpan,
  TestController,
  V1Controller,
  V2Controller,
} from "./http-fixture.js";

registerHostContext();

const selected = (process.env.CONFORMANCE_ADAPTERS ?? ADAPTERS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const adapters = ADAPTERS.filter((a) => selected.includes(a));
const nestVersion = process.env.CONFORMANCE_NEST ?? "latest 12.x";
// Nest 12.0.0's Fastify adapter cannot start an app with two versions of one route under header
// versioning (FST_ERR_DUPLICATED_ROUTE, "Method 'GET' already declared"): a Nest limit, found in
// P0-S1 (docs/spikes/P0-S1.md, question 9), before any Nestrix code runs. The row is skipped there.
const headerVersioningUnavailable = (adapter: string) =>
  adapter === "fastify" && nestVersion === "12.0.0";

type RawReq = Readable & { headers: Record<string, string> };

/** Reads the multipart body with the platform's parser, then opens a span in the handler. */
@Controller("conformance")
class MultipartController {
  @Post("multipart")
  async multipart(
    @Req() req: RawReq & { raw?: RawReq },
  ): Promise<{ name: string; size: number }> {
    const raw = req.raw ?? req;
    const form = await new Response(
      Readable.toWeb(raw) as ReadableStream<Uint8Array>,
      { headers: { "content-type": raw.headers["content-type"] as string } },
    ).formData();
    return withSpan("handler.multipart", () => {
      for (const value of form.values()) {
        if (typeof value !== "string") {
          return { name: value.name, size: value.size };
        }
      }
      throw new Error("no file in the form");
    });
  }
}

let booted: BootedApp | undefined;
beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  faultInjection.site = undefined;
  await booted?.close();
  booted = undefined;
});

const exceptionEvents = (s: ReadableSpan) =>
  s.events.filter((e) => e.name === "exception");
const durationMs = (s: ReadableSpan) =>
  s.duration[0] * 1000 + s.duration[1] / 1e6;

describe.each(adapters)(
  `conformance on %s (Nest ${nestVersion})`,
  (adapter) => {
    async function boot(): Promise<BootedApp> {
      booted = await bootApp(adapter, {
        module: rootModule([TestController, MultipartController]),
      });
      return booted;
    }

    it("Matched route, 200: named METHOD /route/:template; route attribute set; status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/users/42`);
      expect(res.status).toBe(200);
      const span = await serverSpan(app, "/users/42");
      expect(span.name).toBe("GET /users/:id");
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.attributes["http.route"]).toBe("/users/:id");
      expect(span.attributes["http.request.method"]).toBe("GET");
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.attributes["code.function.name"]).toBe("AppController.user");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(exceptionEvents(span)).toHaveLength(0);
      expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
    });

    it("Unmatched request, 404: named by method only; no route attribute; status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/nowhere/at/all`);
      expect(res.status).toBe(404);
      const span = await serverSpan(app, "/nowhere/at/all");
      expect(span.name).toBe("GET");
      expect(span.attributes["http.route"]).toBeUndefined();
      expect(span.attributes["http.response.status_code"]).toBe(404);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("Guard rejects, 403: named with the route template; status unset; no exception at level 1", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/private`);
      expect(res.status).toBe(403);
      const span = await serverSpan(app, "/private");
      expect(span.name).toBe("GET /private");
      expect(span.attributes["http.route"]).toBe("/private");
      expect(span.attributes["http.response.status_code"]).toBe(403);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(exceptionEvents(span)).toHaveLength(0);
    });

    it("Handler throws an HttpException below 500: exception recorded as an event; status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/teapot`);
      expect(res.status).toBe(418);
      const span = await serverSpan(app, "/teapot");
      expect(span.name).toBe("GET /teapot");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(exceptionEvents(span)).toHaveLength(1);
      expect(exceptionEvents(span)[0]?.attributes).toMatchObject({
        "exception.type": "HttpException",
      });
    });

    it("Handler throws anything else, 500: exception recorded; status error", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/boom`);
      expect(res.status).toBe(500);
      const span = await serverSpan(app, "/boom");
      expect(span.name).toBe("GET /boom");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["http.response.status_code"]).toBe(500);
      expect(span.attributes["error.type"]).toBe("Error");
      expect(exceptionEvents(span)).toHaveLength(1);
      expect(exceptionEvents(span)[0]?.attributes).toMatchObject({
        "exception.type": "Error",
        "exception.message": "boom",
      });
    });

    it("Exception filter turns an error into a 200: exception recorded; status unset", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/filtered`);
      expect(res.status).toBe(200);
      const span = await serverSpan(app, "/t/filtered");
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes["error.type"]).toBeUndefined();
      expect(exceptionEvents(span)).toHaveLength(1);
      expect(exceptionEvents(span)[0]?.attributes).toMatchObject({
        "exception.message": "turned into a 200",
      });
    });

    it("Streamed response: ends when the stream closes; duration covers the stream", async () => {
      const app = await boot();
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/stream`);
      expect(await res.text()).toBe("chunk 1\nchunk 2\nchunk 3\nchunk 4\n");
      const elapsed = Date.now() - started;
      const span = await serverSpan(app, "/stream");
      // Four chunks, 250 ms apart: the span is not ended at the response head.
      expect(durationMs(span)).toBeGreaterThanOrEqual(900);
      // Upper bound: the span does not outlive the response (e.g. until the keep-alive
      // timeout, 5 s). 500 ms of slack: `close` can lag the client's last read under load.
      expect(durationMs(span)).toBeLessThanOrEqual(elapsed + 500);
      expect(span.attributes["nestrix.http.aborted"]).toBeUndefined();
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("Client aborts mid-response: ends on close; marked as aborted", async () => {
      const app = await boot();
      await rawRequest(app.baseUrl, "/stream", { destroyOnFirstData: true });
      const span = await serverSpan(app, "/stream");
      expect(span.attributes["nestrix.http.aborted"]).toBe(true);
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      // Ended on close, long before the stream would have finished.
      expect(durationMs(span)).toBeLessThan(900);
    });

    it("POST with a JSON body: a span created in the handler is a child of the server span", async () => {
      const app = await boot();
      const res = await fetch(`${app.baseUrl}/t/child`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(await res.json()).toEqual({ a: 1 });
      const span = await serverSpan(app, "/t/child");
      const child = await app.waitForSpan("handler.child");
      expect(span.name).toBe("POST /t/child");
      expect(child.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(span.spanContext().traceId);
    });

    it("Multipart upload: a span created in the handler is a child of the server span", async () => {
      const app = await boot();
      const form = new FormData();
      form.append("file", new Blob(["hello world"]), "hello.txt");
      const res = await fetch(`${app.baseUrl}/conformance/multipart`, {
        method: "POST",
        body: form,
      });
      expect(await res.json()).toEqual({ name: "hello.txt", size: 11 });
      const span = await serverSpan(app, "/conformance/multipart");
      const child = await app.waitForSpan("handler.multipart");
      expect(span.name).toBe("POST /conformance/multipart");
      expect(child.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(span.spanContext().traceId);
    });

    it.skipIf(headerVersioningUnavailable(adapter))(
      "Header versioning, two versions of one route: route attribute is the one that handled the request",
      async () => {
        booted = await bootApp(adapter, {
          module: rootModule([V1Controller, V2Controller], undefined, false),
          configure: (app) =>
            app.enableVersioning({
              type: VersioningType.HEADER,
              header: "x-api-version",
            } satisfies VersioningOptions),
        });
        const r2 = await fetch(`${booted.baseUrl}/ver/a`, {
          headers: { "x-api-version": "2" },
        });
        expect(await r2.text()).toBe("v2:a");
        const r1 = await fetch(`${booted.baseUrl}/ver/b`, {
          headers: { "x-api-version": "1" },
        });
        expect(await r1.text()).toBe("v1:b");
        const s2 = await serverSpan(booted, "/ver/a");
        const s1 = await serverSpan(booted, "/ver/b");
        for (const s of [s1, s2]) {
          expect(s.name).toBe("GET /ver/:id");
          expect(s.attributes["http.route"]).toBe("/ver/:id");
        }
        // The handling version, not just the shared template.
        expect(s2.attributes["code.function.name"]).toBe("V2Controller.two");
        expect(s1.attributes["code.function.name"]).toBe("V1Controller.one");
      },
    );

    it("Global prefix and URI versioning: route attribute includes both", async () => {
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
    });

    it("Nestrix's own hook throws (injected fault): the request succeeds; the fault is counted", async () => {
      const sites: [FaultSite, string][] = [
        ["request-hook", "http.request-hook"],
        ["route-hook", "http.route-hook"],
        ["close-listener", "http.close-listener"],
        ["interceptor", "http.interceptor"],
      ];
      const app = await boot();
      for (const [site, counted] of sites) {
        resetDiagnosticsForTests();
        faultInjection.site = site;
        const res = await fetch(`${app.baseUrl}/users/9`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "9" });
        expect(getFailureCounts().get(counted)).toBeGreaterThanOrEqual(1);
      }
      // The interceptor's error path counts too, and the handler's own error still reaches the client.
      resetDiagnosticsForTests();
      faultInjection.site = "interceptor-error";
      const boom = await fetch(`${app.baseUrl}/boom`);
      expect(boom.status).toBe(500);
      expect(
        getFailureCounts().get("http.interceptor-error"),
      ).toBeGreaterThanOrEqual(1);
    });

    it("App bootstrapped through @nestjs/testing: spans are produced; route template present for requests that reach a handler", async () => {
      booted = await bootApp(adapter, {
        testing: true,
        module: rootModule([TestController]),
      });
      const res = await fetch(`${booted.baseUrl}/users/5`);
      expect(res.status).toBe(200);
      const span = await serverSpan(booted, "/users/5");
      expect(span.name).toBe("GET /users/:id");
      expect(span.attributes["http.route"]).toBe("/users/:id");
      expect(span.attributes["code.function.name"]).toBe("AppController.user");
      // A request that reaches no handler still gets a span, named by method.
      await fetch(`${booted.baseUrl}/missing`);
      const missing = await serverSpan(booted, "/missing");
      expect(missing.name).toBe("GET");
      expect(missing.attributes["http.route"]).toBeUndefined();
    });
  },
);
