// Global state: a host tracer provider (bootApp's in-memory exporter), an ALS context manager
// and a W3C propagator, registered before Nestrix. Nestrix uses the host's SDK.
// P3-03: the `user` option on Express, Fastify and platform-node, with a guard that sets
// `request.user`, and every way the user's function can misbehave.
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  Param,
  UseGuards,
} from "@nestjs/common";
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { INVALID_SPAN_CONTEXT, trace } from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  diagnostics,
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { faultInjection } from "../src/http/request-state.js";
import {
  ATTR_USER_ID,
  HttpServerInstrumentation,
  MAX_USER_ID_LENGTH,
  userIdOf,
} from "../src/http/server.js";
import { resolveOptions } from "../src/resolve-options.js";
import {
  ADAPTERS,
  DEFAULT_TEST_OPTIONS,
  registerHostContext,
  rootModule,
  serverSpan,
} from "./http-fixture.js";

registerHostContext();

/** What the guard saw, per request, keyed by the `n` path parameter. */
const guardRequests = new Map<string, Record<string, unknown>>();
/** Every argument the `user` function was called with, in order. */
const userCalls: unknown[] = [];
/** The behaviour of the `user` function; tests swap it. */
let impl: (request: unknown) => unknown = (request) =>
  (request as { user?: { id?: unknown } }).user?.id;

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx
      .switchToHttp()
      .getRequest<
        Record<string, unknown> & { headers: Record<string, string> }
      >();
    const n = (request.params as Record<string, string> | undefined)?.n;
    if (n !== undefined) guardRequests.set(n, request);
    const who = request.headers["x-user"];
    if (who === undefined) return false; // 403 before any user is set
    request.user = { id: who === "<number>" ? 42 : who };
    return true;
  }
}

@Controller("u")
class UserController {
  @Get("me/:n")
  @UseGuards(AuthGuard)
  me(@Param("n") n: string): string {
    return `ok ${n}`;
  }

  @Get("boom/:n")
  @UseGuards(AuthGuard)
  boom(): string {
    throw new Error("handler failed");
  }

  @Get("open/:n")
  open(@Param("n") n: string): string {
    return `open ${n}`;
  }
}

let n = 0;
const next = () => String(++n);

describe.each(ADAPTERS)("user option on %s", (adapter) => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp(adapter, {
      module: rootModule([UserController], {
        ...DEFAULT_TEST_OPTIONS,
        user: (request) => {
          userCalls.push(request);
          return impl(request) as string;
        },
      }),
    });
  });
  afterAll(async () => {
    await booted.close();
  });
  beforeEach(() => {
    resetDiagnosticsForTests();
    userCalls.length = 0;
    impl = (request) => (request as { user?: { id?: unknown } }).user?.id;
  });
  afterEach(() => {
    faultInjection.site = undefined;
  });

  async function call(
    route: "me" | "boom" | "open",
    headers: Record<string, string> = { "x-user": "alice" },
  ) {
    const id = next();
    const res = await fetch(`${booted.baseUrl}/u/${route}/${id}`, { headers });
    const body = await res.text();
    const span = await serverSpan(booted, `/u/${route}/${id}`);
    return { id, res, body, span };
  }

  it("records request.user set by a guard as user.id, calling the function once with the guard's request object", async () => {
    const { id, res, body, span } = await call("me");
    expect(res.status).toBe(200);
    expect(body).toBe(`ok ${id}`);
    expect(span.attributes[ATTR_USER_ID]).toBe("alice");
    expect(userCalls).toHaveLength(1);
    // The very object guards see (and set `user` on) is what the function receives.
    const seen = guardRequests.get(id);
    expect(seen).toBeDefined();
    expect(userCalls[0]).toBe(seen);
    if (adapter === "fastify") {
      // Fastify: a FastifyRequest wrapper; the raw IncomingMessage does not carry `user`.
      expect(userCalls[0]).not.toBeInstanceOf(IncomingMessage);
      const raw = (userCalls[0] as { raw?: unknown }).raw;
      expect(raw).toBeInstanceOf(IncomingMessage);
      expect((raw as { user?: unknown }).user).toBeUndefined();
    } else {
      // Express and platform-node: the Node IncomingMessage itself.
      expect(userCalls[0]).toBeInstanceOf(IncomingMessage);
    }
    expect(getFailureCounts().size).toBe(0);
  });

  it("records a numeric id as its decimal text", async () => {
    const { span } = await call("me", { "x-user": "<number>" });
    expect(span.attributes[ATTR_USER_ID]).toBe("42");
  });

  it("records the user of a request whose handler throws (500)", async () => {
    const { res, span } = await call("boom");
    expect(res.status).toBe(500);
    expect(span.attributes[ATTR_USER_ID]).toBe("alice");
  });

  it("records nothing, and counts nothing, when no guard set a user (open route, guard-rejected route)", async () => {
    const open = await call("open", {});
    expect(open.res.status).toBe(200);
    expect(open.span.attributes[ATTR_USER_ID]).toBeUndefined();
    const denied = await call("me", {});
    expect(denied.res.status).toBe(403);
    expect(denied.span.attributes[ATTR_USER_ID]).toBeUndefined();
    expect(userCalls).toHaveLength(2);
    expect(getFailureCounts().size).toBe(0);
  });

  it("a throwing function leaves the response unchanged, records nothing and is counted", async () => {
    impl = () => {
      throw new Error("user lookup failed");
    };
    const { id, res, body, span } = await call("me");
    expect(res.status).toBe(200);
    expect(body).toBe(`ok ${id}`);
    expect(span.attributes[ATTR_USER_ID]).toBeUndefined();
    expect(span.ended).toBe(true);
    expect(getFailureCounts().get("http.user")).toBe(1);
  });

  it.each([
    ["an object", () => ({ id: "alice" })],
    ["a boolean", () => true],
    ["NaN", () => Number.NaN],
    ["a symbol", () => Symbol("u")],
  ])(
    "an invalid result (%s) records nothing and is counted",
    async (_label, fn) => {
      impl = fn;
      const { res, span } = await call("me");
      expect(res.status).toBe(200);
      expect(span.attributes[ATTR_USER_ID]).toBeUndefined();
      expect(getFailureCounts().get("http.user")).toBe(1);
    },
  );

  it("a promise (async function) records nothing, is counted, and its rejection never reaches unhandledRejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      impl = async () => {
        throw new Error("async user lookup failed");
      };
      const { res, span } = await call("me");
      expect(res.status).toBe(200);
      expect(span.attributes[ATTR_USER_ID]).toBeUndefined();
      expect(getFailureCounts().get("http.user")).toBe(1);
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("cuts a long id to 256 characters", async () => {
    impl = () => "x".repeat(1000);
    const { span } = await call("me");
    expect(span.attributes[ATTR_USER_ID]).toBe("x".repeat(MAX_USER_ID_LENGTH));
  });

  it("an injected fault in Nestrix's own user step is counted; the span still ends with its status", async () => {
    faultInjection.site = "user";
    const { res, span } = await call("me");
    expect(res.status).toBe(200);
    expect(span.ended).toBe(true);
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.attributes[ATTR_USER_ID]).toBeUndefined();
    expect(userCalls).toHaveLength(0);
    expect(getFailureCounts().get("http.user")).toBe(1);
  });
});

describe("user option (unit)", () => {
  beforeEach(() => resetDiagnosticsForTests());
  afterEach(() => vi.restoreAllMocks());

  function exchange() {
    const res = Object.assign(new EventEmitter(), {
      headersSent: true,
      statusCode: 200,
      writableEnded: true,
      writableFinished: true,
      getHeaders: () => ({}),
    });
    const req = {
      method: "GET",
      url: "/x",
      headers: {},
      httpVersion: "1.1",
      socket: {},
    };
    return { req, res };
  }

  it("is not called for a span that is not recording (sampled out)", () => {
    const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    const end = vi.spyOn(span, "end");
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => span,
      startActiveSpan: (() => undefined) as never,
    });
    const user = vi.fn(() => "alice");
    const instrumentation = new HttpServerInstrumentation(
      resolveOptions({ user }, {}),
      diagnostics,
    );
    const { req, res } = exchange();
    const done = vi.fn();
    instrumentation.requestHook(req, res, done);
    res.emit("close");
    expect(done).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(user).not.toHaveBeenCalled();
    expect(getFailureCounts().size).toBe(0);
  });

  it("is called once even when close fires twice, with the request the hook received", () => {
    const user = vi.fn(() => "alice");
    const setAttribute = vi.fn();
    const span = {
      isRecording: () => true,
      setAttribute,
      setStatus: vi.fn(),
      updateName: vi.fn(),
      end: vi.fn(),
      spanContext: () => INVALID_SPAN_CONTEXT,
    };
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => span as never,
      startActiveSpan: (() => undefined) as never,
    });
    const instrumentation = new HttpServerInstrumentation(
      resolveOptions({ user }, {}),
      diagnostics,
    );
    const { req, res } = exchange();
    // As Fastify passes it: a wrapper whose `raw` is the Node request.
    const wrapper = { raw: req, user: { id: "alice" } };
    const reply = { raw: res, getHeaders: () => ({}) };
    instrumentation.requestHook(wrapper, reply, vi.fn());
    res.emit("close");
    res.emit("close");
    expect(user).toHaveBeenCalledTimes(1);
    expect(user).toHaveBeenCalledWith(wrapper);
    expect(setAttribute).toHaveBeenCalledWith(ATTR_USER_ID, "alice");
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("a thenable whose then() throws is counted, never thrown", () => {
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () =>
        ({
          isRecording: () => true,
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          updateName: vi.fn(),
          end: vi.fn(),
          spanContext: () => INVALID_SPAN_CONTEXT,
        }) as never,
      startActiveSpan: (() => undefined) as never,
    });
    const user = vi.fn(() => ({
      // biome-ignore lint/suspicious/noThenProperty: the point of the test
      then() {
        throw new Error("then");
      },
    }));
    const instrumentation = new HttpServerInstrumentation(
      resolveOptions({ user: user as never }, {}),
      diagnostics,
    );
    const { req, res } = exchange();
    instrumentation.requestHook(req, res, vi.fn());
    expect(() => res.emit("close")).not.toThrow();
    expect(user).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().get("http.user")).toBe(1);
    expect(getFailureCounts().get("http.close-listener")).toBeUndefined();
  });

  it("userIdOf normalises results", () => {
    expect(userIdOf("alice")).toBe("alice");
    expect(userIdOf(7)).toBe("7");
    expect(userIdOf(12345678901234567890n)).toBe("12345678901234567890");
    expect(userIdOf(undefined)).toBeUndefined();
    expect(userIdOf(null)).toBeUndefined();
    expect(userIdOf("")).toBeUndefined();
    expect(userIdOf(Number.POSITIVE_INFINITY)).toBe(false);
    expect(userIdOf({})).toBe(false);
    expect(userIdOf(true)).toBe(false);
    expect(userIdOf("y".repeat(300))).toHaveLength(256);
    // Never half a surrogate pair at the cut.
    const emoji = `${"a".repeat(255)}\u{1F600}`;
    expect(userIdOf(emoji)).toBe("a".repeat(255));
  });

  it("forRoot rejects a user option that is not a function", () => {
    expect(() => resolveOptions({ user: "req.user.id" as never }, {})).toThrow(
      /user must be a function/,
    );
    expect(resolveOptions({}, {}).user).toBeUndefined();
  });
});
