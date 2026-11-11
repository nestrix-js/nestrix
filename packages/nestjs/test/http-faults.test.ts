// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// Rule 1 for the HTTP hooks and the interceptor: a fault anywhere in Nestrix's code leaves the
// host's request unchanged, `done()` runs exactly once, and the fault is counted.
import { EventEmitter } from "node:events";
import { type BootedApp, bootApp } from "@nestrix/testing";
import { context, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  diagnostics,
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { type FaultSite, faultInjection } from "../src/http/request-state.js";
import { HttpServerInstrumentation } from "../src/http/server.js";
import { resolveOptions } from "../src/resolve-options.js";
import {
  ADAPTERS,
  registerHostContext,
  rootModule,
  serverSpan,
} from "./http-fixture.js";

registerHostContext();

let booted: BootedApp | undefined;
beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  faultInjection.site = undefined;
  vi.restoreAllMocks();
  await booted?.close();
  booted = undefined;
});

function instrumentation(ignore: unknown[] = []): HttpServerInstrumentation {
  return new HttpServerInstrumentation(
    resolveOptions({ ignore: { routes: ignore as never } }, {}),
    diagnostics,
  );
}

function fakeExchange(url = "/x") {
  const res = Object.assign(new EventEmitter(), {
    headersSent: true,
    statusCode: 200,
    writableEnded: true,
    writableFinished: true,
    getHeaders: () => ({}),
  });
  const req = {
    method: "GET",
    url,
    headers: {},
    httpVersion: "1.1",
    socket: {},
  };
  return { req, res };
}

describe("request hook contract (unit)", () => {
  it("calls done exactly once on the normal path", () => {
    const { req, res } = fakeExchange();
    const done = vi.fn();
    instrumentation().requestHook(req, res, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith();
  });

  it.each([
    ["no request", null, fakeExchange().res],
    ["no response", fakeExchange().req, null],
    ["a response without once()", fakeExchange().req, {}],
    [
      "a request with a throwing getter",
      Object.defineProperty({}, "url", {
        get() {
          throw new Error("getter");
        },
      }),
      fakeExchange().res,
    ],
  ])("calls done exactly once with %s", (_label, req, res) => {
    const done = vi.fn();
    expect(() => instrumentation().requestHook(req, res, done)).not.toThrow();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith();
  });

  it("calls done once and counts an injected fault", () => {
    faultInjection.site = "request-hook";
    const done = vi.fn();
    const { req, res } = fakeExchange();
    instrumentation().requestHook(req, res, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().get("http.request-hook")).toBe(1);
  });

  it("calls done once when the context manager throws before running it", () => {
    vi.spyOn(context, "with").mockImplementation(() => {
      throw new Error("context manager broke");
    });
    const done = vi.fn();
    const { req, res } = fakeExchange();
    instrumentation().requestHook(req, res, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().get("http.request-hook")).toBe(1);
  });

  it("does not call done again when the context manager throws after running it", () => {
    vi.spyOn(context, "with").mockImplementation(((
      _ctx: unknown,
      fn: () => void,
    ) => {
      fn();
      throw new Error("context manager broke on exit");
    }) as never);
    const done = vi.fn();
    const { req, res } = fakeExchange();
    expect(() => instrumentation().requestHook(req, res, done)).not.toThrow();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error thrown by done() itself, unchanged, after one call", () => {
    const nestError = new Error("thrown by Nest's continuation");
    const done = vi.fn(() => {
      throw nestError;
    });
    const { req, res } = fakeExchange();
    let caught: unknown;
    try {
      instrumentation().requestHook(req, res, done);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(nestError);
    expect(done).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().size).toBe(0);
  });

  it("returns undefined (never a promise Fastify would wait on)", () => {
    const { req, res } = fakeExchange();
    expect(
      instrumentation().requestHook(req, res, () => undefined),
    ).toBeUndefined();
  });

  it("ends the span exactly once, also for a response already closed when the hook runs", () => {
    const end = vi.fn();
    const span = {
      end,
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      updateName: vi.fn(),
      spanContext: () => ({
        traceId: `${"0".repeat(31)}1`,
        spanId: `${"0".repeat(15)}1`,
        traceFlags: 1,
      }),
      isRecording: () => true,
    };
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => span,
    } as never);
    const { req, res } = fakeExchange();
    Object.assign(res, { closed: true });
    instrumentation().requestHook(req, res, () => undefined);
    expect(end).toHaveBeenCalledTimes(1); // ended at once: `close` already happened
    res.emit("close"); // late `close` (if Node had still queued it): no second end
    res.emit("close");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends the span when the close listener faults", () => {
    const end = vi.fn();
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => ({
        end,
        setAttribute: vi.fn(),
        spanContext: () => ({
          traceId: `${"0".repeat(31)}1`,
          spanId: `${"0".repeat(15)}1`,
          traceFlags: 1,
        }),
      }),
    } as never);
    faultInjection.site = "close-listener";
    const { req, res } = fakeExchange();
    instrumentation().requestHook(req, res, () => undefined);
    res.emit("close");
    expect(end).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().get("http.close-listener")).toBe(1);
  });

  it("ignores the request when a user ignore matcher throws (counts as a match), and counts it", () => {
    const { req, res } = fakeExchange("/y");
    const done = vi.fn();
    instrumentation([
      () => {
        throw new Error("user matcher");
      },
    ]).requestHook(req, res, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith();
    expect(res.listenerCount("close")).toBe(0); // no span started
    expect(getFailureCounts().get("http.ignore-routes")).toBe(1);
  });
});

describe("route hook contract (unit)", () => {
  it("calls the previous hook exactly once with the same arguments, even on a fault", () => {
    faultInjection.site = "route-hook";
    const previous = vi.fn();
    instrumentation().routeHook(previous)(0, "/a/:b");
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(0, "/a/:b");
    expect(getFailureCounts().get("http.route-hook")).toBe(1);
  });

  it("lets the previous hook's own error through, as it would without Nestrix", () => {
    const error = new Error("previous hook");
    const hook = instrumentation().routeHook(() => {
      throw error;
    });
    expect(() => hook(0, "/a")).toThrow(error);
    expect(getFailureCounts().size).toBe(0);
  });

  it("ignores a previous value that is not a function", () => {
    expect(() => instrumentation().routeHook("nope")(0, "/a")).not.toThrow();
  });
});

const SITES: { site: FaultSite; counted: string }[] = [
  { site: "request-hook", counted: "http.request-hook" },
  { site: "route-hook", counted: "http.route-hook" },
  { site: "close-listener", counted: "http.close-listener" },
  { site: "interceptor", counted: "http.interceptor" },
  { site: "interceptor-error", counted: "http.interceptor-error" },
];

describe.each(ADAPTERS)("injected faults on %s", (adapter) => {
  it.each(SITES)(
    "$site: the host's responses are unchanged and the fault is counted",
    async ({ site, counted }) => {
      booted = await bootApp(adapter, { module: rootModule([]) });
      // Baseline without a fault.
      const okBefore = await fetch(`${booted.baseUrl}/users/1`);
      const boomBefore = await fetch(`${booted.baseUrl}/boom`);
      const baseline = {
        ok: [okBefore.status, await okBefore.text()],
        boom: [boomBefore.status, await boomBefore.text()],
      };

      faultInjection.site = site;
      const ok = await fetch(`${booted.baseUrl}/users/1`);
      const boom = await fetch(`${booted.baseUrl}/boom`);
      const forbidden = await fetch(`${booted.baseUrl}/private`);
      expect([ok.status, await ok.text()]).toEqual(baseline.ok);
      expect([boom.status, await boom.text()]).toEqual(baseline.boom);
      expect(forbidden.status).toBe(403);
      expect(getFailureCounts().get(counted)).toBeGreaterThanOrEqual(1);

      // Cleared: the next request is traced normally.
      faultInjection.site = undefined;
      await fetch(`${booted.baseUrl}/users/2`);
      expect((await serverSpan(booted, "/users/2")).name).toBe(
        "GET /users/:id",
      );
    },
  );
});
