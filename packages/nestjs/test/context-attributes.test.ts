// Global state: a host tracer provider (bootApp's in-memory exporter), an ALS context manager
// and a W3C propagator, registered before Nestrix. Nestrix uses the host's SDK.
// Issue #27, D-102: the `context` option and `setTraceAttributes()` on Express, Fastify and
// platform-node, every way the function can misbehave, and the propagation of allow-listed keys
// into BullMQ job metadata and outgoing requests (no Redis: the telemetry object is driven as
// BullMQ drives it; test/e2e-phase3/jobs-context.test.ts runs it through a real queue).
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  UseGuards,
} from "@nestjs/common";
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { context, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mergeBaggage,
  outgoingBaggage,
  parseBaggage,
  setTraceAttributes,
} from "../src/context/trace-attributes.js";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { faultInjection } from "../src/http/request-state.js";
import { NestrixModule } from "../src/index.js";
import { bullmqTelemetry } from "../src/jobs/bullmq.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { resolveOptions } from "../src/resolve-options.js";
import {
  ADAPTERS,
  DEFAULT_TEST_OPTIONS,
  registerHostContext,
  rootModule,
  serverSpan,
} from "./http-fixture.js";

registerHostContext();

/** The behaviour of the `context` function; tests swap it. */
let impl: (request: unknown) => unknown = () => undefined;
let calls = 0;

const telemetry = bullmqTelemetry();
/** A server that records the headers of each request it gets (an outgoing request's target). */
let downstream: Server;
let downstreamUrl = "";
const received: IncomingHttpHeaders[] = [];

@Injectable()
class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx
      .switchToHttp()
      .getRequest<
        Record<string, unknown> & { headers: Record<string, string> }
      >();
    request.user = { tenant: request.headers["x-tenant"] };
    return true;
  }
}

function headerOf(request: unknown, name: string): string | undefined {
  const headers = (request as { headers?: Record<string, unknown> }).headers;
  const value = headers?.[name];
  return typeof value === "string" ? value : undefined;
}

const tenantOf = (request: unknown): string | undefined =>
  (request as { user?: { tenant?: string } }).user?.tenant;

@Controller("c")
@UseGuards(TenantGuard)
class ContextController {
  @Get("plain")
  plain(): string {
    return "plain";
  }

  /** Queues "a job" as BullMQ's producer does: the metadata of the active context. */
  @Get("queue")
  queue(): string {
    return telemetry.contextManager.getMetadata(context.active());
  }

  @Get("set")
  set(): string {
    setTraceAttributes({ "order.id": 7, "app.flag": true, "http.route": "x" });
    return "set";
  }

  @Get("outgoing")
  async outgoing(): Promise<string> {
    await fetch(downstreamUrl);
    return "outgoing";
  }
}

const CONTEXT = (request: unknown) => {
  calls++;
  return impl(request) as Record<string, string>;
};

describe.each(ADAPTERS)("context option on %s", (adapter) => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp(adapter, {
      module: rootModule([ContextController], {
        ...DEFAULT_TEST_OPTIONS,
        context: CONTEXT,
        contextPropagation: { keys: ["tenant.id"] },
      }),
    });
  });
  afterAll(async () => {
    await booted.close();
  });
  beforeEach(() => {
    resetDiagnosticsForTests();
    calls = 0;
    impl = (request) => ({
      "tenant.id": tenantOf(request),
      "app.plan": headerOf(request, "x-plan"),
      "app.seats": 12,
      "app.trial": false,
    });
  });
  afterEach(() => {
    faultInjection.site = undefined;
  });

  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${booted.baseUrl}${path}`, {
      headers: { "x-tenant": "acme", "x-plan": "gold", ...headers },
    });
    const body = await res.text();
    const span = await serverSpan(booted, path);
    return { res, body, span };
  };

  it("sets the values on the server span, once per request, after guards ran", async () => {
    const { res, span } = await call("/c/plain");
    expect(res.status).toBe(200);
    expect(span.attributes["tenant.id"]).toBe("acme");
    expect(span.attributes["app.plan"]).toBe("gold");
    expect(span.attributes["app.seats"]).toBe(12);
    expect(span.attributes["app.trial"]).toBe(false);
    expect(calls).toBe(1);
    expect(getFailureCounts().size).toBe(0);
  });

  it("an undefined value skips its key", async () => {
    impl = () => ({ "tenant.id": undefined, "app.plan": "free" });
    const { span } = await call("/c/plain");
    expect(span.attributes["tenant.id"]).toBeUndefined();
    expect(span.attributes["app.plan"]).toBe("free");
    expect(getFailureCounts().size).toBe(0);
  });

  it("a throwing function leaves the response unchanged, records nothing and is counted", async () => {
    impl = () => {
      throw new Error("tenant lookup failed");
    };
    const { res, body, span } = await call("/c/plain");
    expect(res.status).toBe(200);
    expect(body).toBe("plain");
    expect(span.attributes["tenant.id"]).toBeUndefined();
    expect(span.ended).toBe(true);
    expect(getFailureCounts().get("http.context")).toBe(1);
  });

  it("a fault injected inside Nestrix's own context step does not fail the request", async () => {
    faultInjection.site = "context";
    const { res, body, span } = await call("/c/plain");
    expect(res.status).toBe(200);
    expect(body).toBe("plain");
    expect(span.attributes["tenant.id"]).toBeUndefined();
    expect(span.ended).toBe(true);
    expect(getFailureCounts().get("http.context")).toBe(1);
  });

  it("a throwing function in the request's propagation path (a job queued by the handler) does not fail the request", async () => {
    impl = () => {
      throw new Error("tenant lookup failed");
    };
    const { res, body } = await call("/c/queue");
    expect(res.status).toBe(200);
    expect(JSON.parse(body).baggage).toBeUndefined();
    expect(calls).toBe(1);
    expect(getFailureCounts().get("http.context")).toBe(1);
  });

  it.each([
    ["a promise", () => Promise.reject(new Error("async"))],
    ["an array", () => ["tenant"]],
    ["a string", () => "acme"],
  ])(
    "an invalid result (%s) records nothing and is counted",
    async (_label, result) => {
      impl = result;
      const { res, span } = await call("/c/plain");
      expect(res.status).toBe(200);
      expect(span.attributes["tenant.id"]).toBeUndefined();
      expect(getFailureCounts().get("http.context")).toBe(1);
    },
  );

  it("refuses reserved or malformed keys and invalid values, and keeps the rest", async () => {
    impl = () => ({
      "http.route": "/forged",
      "user.id": "mallory",
      "nestrix.exception.expected": true,
      "bad key": "x",
      "app.obj": { nested: true },
      "app.nan": Number.NaN,
      "tenant.id": "acme",
    });
    const { span } = await call("/c/plain");
    expect(span.attributes["http.route"]).toBe("/c/plain");
    expect(span.attributes["user.id"]).toBeUndefined();
    expect(span.attributes["nestrix.exception.expected"]).toBeUndefined();
    expect(span.attributes["bad key"]).toBeUndefined();
    expect(span.attributes["app.obj"]).toBeUndefined();
    expect(span.attributes["app.nan"]).toBeUndefined();
    expect(span.attributes["tenant.id"]).toBe("acme");
    expect(getFailureCounts().get("http.context")).toBe(6);
  });

  it("cuts long strings to 256 characters", async () => {
    impl = () => ({ "tenant.id": "t".repeat(1000) });
    const { span } = await call("/c/plain");
    expect(span.attributes["tenant.id"]).toBe("t".repeat(256));
  });

  it("propagates only the allow-listed keys into a job's metadata, read once for the request", async () => {
    const { res, body, span } = await call("/c/queue");
    expect(res.status).toBe(200);
    const carrier = JSON.parse(body) as Record<string, string>;
    expect(carrier.traceparent).toMatch(/^00-/);
    expect(carrier.baggage).toBe("tenant.id=acme");
    expect(calls).toBe(1);
    expect(span.attributes["tenant.id"]).toBe("acme");
    expect(span.attributes["app.plan"]).toBe("gold");
  });

  it("encodes baggage values and reads them back on the job's consumer span", async () => {
    impl = () => ({ "tenant.id": "a,b;c=d é" });
    const { body } = await call("/c/queue");
    const metadata = body;
    const carrier = JSON.parse(metadata) as Record<string, string>;
    expect(carrier.baggage).toBe(
      `tenant.id=${encodeURIComponent("a,b;c=d é")}`,
    );
    // Worker side, as BullMQ's `trace()` runs it: fromMetadata, then the consumer span.
    const parent = telemetry.contextManager.fromMetadata(
      ROOT_CONTEXT,
      metadata,
    );
    const span = telemetry.tracer.startSpan(
      "process q",
      { kind: SpanKind.CONSUMER },
      parent,
    );
    span.end();
    const consumer = booted
      .spans()
      .filter((s) => s.name === "process q")
      .at(-1);
    expect(consumer?.attributes["tenant.id"]).toBe("a,b;c=d é");
  });

  it("setTraceAttributes sets on the request's server span, not on the active span; reserved keys are refused", async () => {
    const { res, span } = await call("/c/set");
    expect(res.status).toBe(200);
    expect(span.attributes["order.id"]).toBe(7);
    expect(span.attributes["app.flag"]).toBe(true);
    expect(span.attributes["http.route"]).toBe("/c/set");
    expect(getFailureCounts().get("context.set-trace-attributes")).toBe(1);
  });

  it("sends no baggage on outgoing requests unless contextPropagation.outgoing is on", async () => {
    received.length = 0;
    const { res } = await call("/c/outgoing");
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.traceparent).toMatch(/^00-/);
    expect(received[0]?.baggage).toBeUndefined();
  });
});

describe("without the context option", () => {
  let booted: BootedApp;
  beforeAll(async () => {
    booted = await bootApp("express", {
      module: rootModule([ContextController], DEFAULT_TEST_OPTIONS),
    });
  });
  afterAll(async () => {
    await booted.close();
  });

  it("records nothing new and puts no baggage in a job's metadata", async () => {
    calls = 0;
    const res = await fetch(`${booted.baseUrl}/c/queue`, {
      headers: { "x-tenant": "acme" },
    });
    const carrier = JSON.parse(await res.text()) as Record<string, string>;
    expect(Object.keys(carrier)).toEqual(["traceparent"]);
    const span = await serverSpan(booted, "/c/queue");
    expect(span.attributes["tenant.id"]).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("reads no baggage back from a job's metadata (the worker lists no keys)", async () => {
    const parent = telemetry.contextManager.fromMetadata(
      ROOT_CONTEXT,
      JSON.stringify({ baggage: "tenant.id=acme" }),
    );
    const span = telemetry.tracer.startSpan(
      "process unlisted",
      { kind: SpanKind.CONSUMER },
      parent,
    );
    span.end();
    const consumer = booted.spans().find((s) => s.name === "process unlisted");
    expect(consumer?.attributes["tenant.id"]).toBeUndefined();
  });
});

describe("contextPropagation.outgoing", () => {
  let booted: BootedApp;
  beforeAll(async () => {
    booted = await bootApp("express", {
      module: rootModule([ContextController], {
        ...DEFAULT_TEST_OPTIONS,
        context: (request) => ({
          "tenant.id": tenantOf(request),
          "app.plan": "gold",
        }),
        contextPropagation: { keys: ["tenant.id"], outgoing: true },
      }),
    });
  });
  afterAll(async () => {
    await booted.close();
  });

  it("takes an allow-listed key out of a propagator's baggage even when this request set none", () => {
    const span = trace.getTracer("test").startSpan("no tenant");
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    expect(outgoingBaggage(ctx, "tenant.id=evil,vendor=1")).toBe("vendor=1");
    expect(outgoingBaggage(ctx, "tenant.id=evil")).toBeNull();
    expect(outgoingBaggage(ctx, undefined)).toBeUndefined();
    span.end();
  });

  it("sends the allow-listed keys in the baggage header, and nothing else", async () => {
    received.length = 0;
    const res = await fetch(`${booted.baseUrl}/c/outgoing`, {
      headers: { "x-tenant": "acme" },
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.baggage).toBe("tenant.id=acme");
  });
});

describe("setTraceAttributes outside a request", () => {
  let booted: BootedApp;
  beforeAll(async () => {
    booted = await bootApp("express", {
      module: rootModule([ContextController], DEFAULT_TEST_OPTIONS),
    });
  });
  afterAll(async () => {
    await booted.close();
  });

  it("is a no-op outside any span and never throws, even on hostile input", () => {
    expect(() => setTraceAttributes({ "tenant.id": "acme" })).not.toThrow();
    const hostile = {
      get "tenant.id"(): string {
        throw new Error("getter");
      },
    };
    expect(() => setTraceAttributes(hostile)).not.toThrow();
    expect(() =>
      setTraceAttributes(null as unknown as Record<string, string>),
    ).not.toThrow();
  });

  it("sets on the active span when no local root is known", () => {
    const span = trace
      .getTracer("test")
      .startSpan("cron tick", { kind: SpanKind.INTERNAL });
    context.with(trace.setSpan(context.active(), span), () =>
      setTraceAttributes({ "tenant.id": "acme" }),
    );
    span.end();
    const found = booted.spans().find((s) => s.name === "cron tick");
    expect(found?.attributes["tenant.id"]).toBe("acme");
  });
});

describe("setTraceAttributes in early middleware", () => {
  let earlyReads = 0;
  @Injectable()
  class EarlyMiddleware implements NestMiddleware {
    use(_req: unknown, _res: unknown, next: () => void): void {
      setTraceAttributes({ "app.early": "yes" });
      next();
    }
  }

  @Controller("early")
  @UseGuards(TenantGuard)
  class EarlyController {
    @Get()
    get(): string {
      return "early";
    }
  }

  @Module({
    imports: [
      NestrixModule.forRoot({
        ...DEFAULT_TEST_OPTIONS,
        context: (request) => {
          earlyReads++;
          return { "tenant.id": tenantOf(request) };
        },
      }),
    ],
    controllers: [EarlyController],
  })
  class EarlyModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(EarlyMiddleware).forRoutes("early");
    }
  }

  it("does not read `context` before a later guard has set what it reads", async () => {
    const booted = await bootApp("express", { module: EarlyModule });
    try {
      const res = await fetch(`${booted.baseUrl}/early`, {
        headers: { "x-tenant": "acme" },
      });
      expect(res.status).toBe(200);
      const span = await serverSpan(booted, "/early");
      expect(span.attributes["app.early"]).toBe("yes");
      expect(span.attributes["tenant.id"]).toBe("acme");
      expect(earlyReads).toBe(1);
    } finally {
      await booted.close();
    }
  });
});

describe("baggage helpers", () => {
  const keys = new Set(["tenant.id"]);
  beforeEach(() => resetDiagnosticsForTests());

  it("drop an allow-listed key arriving in incoming baggage, keep other entries, and add Nestrix's", () => {
    expect(
      mergeBaggage(
        "tenant.id=evil,vendor=1;p",
        new Map([["tenant.id", "acme"]]),
        keys,
      ),
    ).toBe("tenant.id=acme,vendor=1;p");
    expect(mergeBaggage("tenant.id=evil", new Map(), keys)).toBeUndefined();
  });

  it("parse only allow-listed keys, ignore malformed items, cut values", () => {
    expect(
      parseBaggage(
        `x=1, tenant.id = ${"a".repeat(300)} ;prop, broken, =v`,
        keys,
      ),
    ).toEqual(new Map([["tenant.id", "a".repeat(256)]]));
    expect(parseBaggage("tenant.id=%E0%A4%A", keys)).toBeUndefined();
    expect(parseBaggage(42, keys)).toBeUndefined();
  });

  it("read a wrong value from a header cut at the limit never: a partial last item is dropped", () => {
    const host = `vendor=${"x".repeat(8180 - "vendor=".length)}`;
    expect(host.length).toBe(8180);
    // Appended last, as the old merge did: the receiver's cut leaves `tenant.id=a`.
    const old = `${host},tenant.id=acme-corp`;
    expect(parseBaggage(old, keys)).toBeUndefined();
    // A header cut exactly after a whole item still reads the earlier items.
    expect(
      parseBaggage(`tenant.id=acme,vendor=${"x".repeat(9000)}`, keys),
    ).toEqual(new Map([["tenant.id", "acme"]]));
  });

  it("merge puts Nestrix's entries first and keeps the whole header within 8192", () => {
    const host = `vendor=${"x".repeat(8180 - "vendor=".length)}`;
    const entries = new Map([["tenant.id", "acme-corp"]]);
    const merged = mergeBaggage(host, entries, keys);
    // Does not fit: skipped, host data untouched.
    expect(merged).toBe(host);
    expect(getFailureCounts().get("context.propagate")).toBe(1);
    // A worker reading the result gets the right value or none.
    expect(parseBaggage(merged, keys)).toBeUndefined();
    const roomy = `vendor=${"x".repeat(7000)}`;
    const fits = mergeBaggage(roomy, entries, keys) ?? "";
    expect(fits.startsWith("tenant.id=acme-corp,")).toBe(true);
    expect(fits.length).toBeLessThanOrEqual(8192);
    expect(parseBaggage(fits, keys)).toEqual(
      new Map([["tenant.id", "acme-corp"]]),
    );
  });

  it("keep Nestrix's part within its byte budget", () => {
    const many = new Map(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(200)]),
    );
    const merged = mergeBaggage(undefined, many, new Set(many.keys()));
    expect(merged?.length).toBeLessThanOrEqual(4096);
  });
});

describe("option validation", () => {
  const resolve = (o: Partial<NestrixModuleOptions>) => () =>
    resolveOptions({ ...o }, {});

  it("defaults to no context and no propagation", () => {
    const r = resolveOptions({}, {});
    expect(r.context).toBeUndefined();
    expect(r.contextPropagation).toEqual({ keys: [], outgoing: false });
  });

  it("rejects a non-function context and invalid propagation keys at forRoot", () => {
    expect(resolve({ context: "x" as never })).toThrow(/context must be/);
    expect(resolve({ contextPropagation: { keys: ["http.route"] } })).toThrow(
      /reserved prefix/,
    );
    expect(resolve({ contextPropagation: { keys: ["a b"] } })).toThrow(
      /must start with a letter/,
    );
    expect(
      resolve({
        contextPropagation: {
          keys: Array.from({ length: 17 }, (_, i) => `k${i}`),
        },
      }),
    ).toThrow(/at most 16/);
    expect(
      resolve({
        contextPropagation: { keys: ["tenant.id"], outgoing: "yes" as never },
      }),
    ).toThrow(/outgoing must be a boolean/);
  });
});

beforeAll(async () => {
  downstream = createServer((req, res) => {
    received.push(req.headers);
    res.end("ok");
  });
  await new Promise<void>((resolve) =>
    downstream.listen(0, "127.0.0.1", resolve),
  );
  downstreamUrl = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/down`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => downstream.close(() => resolve()));
});
