// Global state: a host-owned SDK 3 provider with an in-memory exporter (methods/helpers.ts).
// `recordError` (issue #24, D-93) and the shared exception recording (D-93, D-94): where the
// report lands, the propagation and expected marks, the `errors.expected` rule, and that nothing
// here ever throws to the caller (rule 1), including with an injected fault.
import "reflect-metadata";
import { HttpException, Module, NotFoundException } from "@nestjs/common";
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import {
  exceptionAttributes,
  installErrorTracking,
  isExpectedException,
  markLocalRoot,
  recordExceptionEvent,
  withLocalRoot,
} from "../src/errors/exception.js";
import { recordError } from "../src/errors/record-error.js";
import {
  faultInjection,
  REQUEST_STATE_KEY,
  type RequestState,
} from "../src/http/request-state.js";
import { NestrixModule } from "../src/nestrix.module.js";
import {
  contextInstrumented,
  resetSpans,
  setupTracing,
  spans,
} from "./methods/helpers.js";

setupTracing();
const tracer = trace.getTracer("test");

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  faultInjection.site = undefined;
  resetSpans();
  resetDiagnosticsForTests();
});

const exceptionEvents = (name: string) =>
  spans()
    .find((s) => s.name === name)
    ?.events.filter((e) => e.name === "exception") ?? [];

describe("recordError", () => {
  it("does nothing while no enabled Nestrix app runs, or when the app is disabled", async () => {
    tracer.startActiveSpan("outer", (span) => {
      recordError(new Error("ignored"));
      span.end();
    });
    recordError(new Error("ignored too"));
    const app = await contextInstrumented(
      (() => {
        @Module({ imports: [NestrixModule.forRoot({ enabled: false })] })
        class Disabled {}
        return Disabled;
      })(),
    );
    recordError(new Error("still ignored"));
    await app.close();
    expect(spans().map((s) => s.name)).toEqual(["outer"]);
    expect(exceptionEvents("outer")).toEqual([]);
  });

  it("records on the active span with escaped=false and the attributes, and fails it by default", () => {
    uninstall = installErrorTracking(undefined);
    tracer.startActiveSpan("work", (span) => {
      recordError(new TypeError("handled"), {
        "app.code": "E42",
        "exception.type": "Spoofed",
        "nestrix.exception.propagated": true,
        "bad.value": { nested: true } as never,
      });
      span.end();
    });
    const work = spans().find((s) => s.name === "work");
    expect(work?.status.code).toBe(SpanStatusCode.ERROR);
    expect(work?.attributes["error.type"]).toBe("TypeError");
    const [event] = exceptionEvents("work");
    expect(event?.attributes).toMatchObject({
      "exception.type": "TypeError",
      "exception.message": "handled",
      "exception.escaped": false,
      "app.code": "E42",
    });
    expect(event?.attributes?.["nestrix.exception.propagated"]).toBeUndefined();
    expect(event?.attributes?.["bad.value"]).toBeUndefined();
  });

  it("an expected exception is marked and does not fail the span unless asked", () => {
    uninstall = installErrorTracking(undefined);
    tracer.startActiveSpan("lookup", (span) => {
      recordError(new NotFoundException("no such order"));
      span.end();
    });
    tracer.startActiveSpan("forced", (span) => {
      recordError(new NotFoundException("no such user"), undefined, {
        fail: true,
      });
      span.end();
    });
    expect(spans().find((s) => s.name === "lookup")?.status.code).toBe(
      SpanStatusCode.UNSET,
    );
    expect(exceptionEvents("lookup")[0]?.attributes).toMatchObject({
      "nestrix.exception.expected": true,
    });
    expect(spans().find((s) => s.name === "forced")?.status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it("goes to the local root of the trace, and marks an error already recorded as propagated", () => {
    uninstall = installErrorTracking(undefined);
    const error = new Error("seen twice");
    const root = tracer.startSpan("job root");
    const rootCtx = withLocalRoot(
      ROOT_CONTEXT,
      root,
      trace.setSpan(ROOT_CONTEXT, root),
    );
    context.with(rootCtx, () => {
      tracer.startActiveSpan("child", (child) => {
        recordExceptionEvent(child, error);
        child.setStatus({ code: SpanStatusCode.ERROR });
        recordError(error, { "job.id": "1" });
        child.end();
      });
    });
    root.end();
    expect(exceptionEvents("child")[0]?.attributes).not.toHaveProperty(
      "nestrix.exception.propagated",
    );
    expect(exceptionEvents("job root")[0]?.attributes).toMatchObject({
      "exception.message": "seen twice",
      "nestrix.exception.propagated": true,
      "job.id": "1",
    });
    expect(spans().find((s) => s.name === "job root")?.status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it("a root of another trace in the context is not used; an ended root falls back to the active span", () => {
    uninstall = installErrorTracking(undefined);
    const root = tracer.startSpan("old root");
    const rootCtx = withLocalRoot(
      ROOT_CONTEXT,
      root,
      trace.setSpan(ROOT_CONTEXT, root),
    );
    context.with(rootCtx, () => {
      // The root is live, but the active span belongs to a new trace.
      tracer.startActiveSpan("new trace", { root: true }, (span) => {
        recordError(new Error("elsewhere"));
        span.end();
      });
    });
    root.end();
    context.with(rootCtx, () => {
      tracer.startActiveSpan("after the root ended", (span) => {
        recordError(new Error("late"));
        span.end();
      });
    });
    expect(exceptionEvents("old root")).toEqual([]);
    expect(exceptionEvents("after the root ended")).toHaveLength(1);
    expect(exceptionEvents("new trace")).toHaveLength(1);
  });

  it("in a request, the server span; in a scheduled tick started inside a request, the tick's root", () => {
    uninstall = installErrorTracking(undefined);
    const request = tracer.startSpan("GET /orders");
    const state: RequestState = {
      span: request,
      method: "GET",
      baseName: "GET",
      route: undefined,
      reached: true,
      exception: undefined,
      ended: false,
    };
    const requestCtx = trace
      .setSpan(ROOT_CONTEXT, request)
      .setValue(REQUEST_STATE_KEY, state);
    context.with(requestCtx, () => {
      tracer.startActiveSpan("OrdersController.list", (method) => {
        recordError(new Error("in the request"));
        method.end();
      });
      const tick = tracer.startSpan("Tick.run", { root: true });
      const tickCtx = markLocalRoot(trace.setSpan(requestCtx, tick), tick);
      context.with(tickCtx, () => {
        tracer.startActiveSpan("ReportService.build", (inner) => {
          recordError(new Error("in the tick"));
          inner.end();
        });
      });
      tick.end();
    });
    request.end();
    expect(
      exceptionEvents("GET /orders").map(
        (e) => e.attributes?.["exception.message"],
      ),
    ).toEqual(["in the request"]);
    expect(state.exception).toEqual({ status: 500, type: "Error" });
    expect(exceptionEvents("OrdersController.list")).toEqual([]);
    expect(
      exceptionEvents("Tick.run").map(
        (e) => e.attributes?.["exception.message"],
      ),
    ).toEqual(["in the tick"]);
  });

  it("outside any span, starts a short span; in an unsampled trace, records nothing", () => {
    uninstall = installErrorTracking(undefined);
    recordError(new Error("no span"));
    const unsampled = trace.wrapSpanContext({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(ROOT_CONTEXT, unsampled), () =>
      recordError(new Error("unsampled")),
    );
    const own = spans().filter((s) => s.name === "recordError");
    expect(own).toHaveLength(1);
    expect(own[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(own[0]?.events[0]?.attributes?.["exception.message"]).toBe(
      "no span",
    );
  });

  it("never throws: an injected fault, hostile errors, attributes and options", () => {
    uninstall = installErrorTracking(undefined);
    faultInjection.site = "record-error";
    expect(() => recordError(new Error("x"))).not.toThrow();
    faultInjection.site = undefined;
    expect(getFailureCounts().get("errors.record-error")).toBe(1);

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter");
        },
        ownKeys() {
          throw new Error("keys");
        },
      },
    );
    tracer.startActiveSpan("hostile", (span) => {
      expect(() => recordError(hostile)).not.toThrow();
      expect(() => recordError(new Error("a"), hostile as never)).not.toThrow();
      expect(() =>
        recordError(new Error("b"), undefined, hostile as never),
      ).not.toThrow();
      expect(() => recordError(Symbol("s"))).not.toThrow();
      span.end();
    });
    expect(exceptionEvents("hostile").length).toBeGreaterThanOrEqual(3);
  });
});

describe("expected exceptions (errors.expected)", () => {
  class DomainError extends Error {}
  class SpecificError extends DomainError {}

  it("default: a mapped status below 500 is expected", () => {
    expect(isExpectedException(new NotFoundException())).toBe(true);
    expect(isExpectedException(new HttpException("teapot", 418))).toBe(true);
    expect(isExpectedException(new HttpException("down", 503))).toBe(false);
    expect(isExpectedException(new Error("boom"))).toBe(false);
    expect(isExpectedException("a string")).toBe(false);
  });

  it("classes (instanceof), names and RegExps add to the default; false turns it off", () => {
    uninstall = installErrorTracking([DomainError, "TypeError", /^Range/]);
    expect(isExpectedException(new SpecificError("x"))).toBe(true);
    expect(isExpectedException(new TypeError("x"))).toBe(true);
    expect(isExpectedException(new RangeError("x"))).toBe(true);
    expect(isExpectedException(new NotFoundException())).toBe(true);
    expect(isExpectedException(new Error("x"))).toBe(false);
    uninstall();
    uninstall = installErrorTracking(false);
    expect(isExpectedException(new NotFoundException())).toBe(false);
  });

  it("a predicate decides; undefined, another value or a throw falls back to the default", () => {
    uninstall = installErrorTracking((e) =>
      e instanceof NotFoundException
        ? false
        : e instanceof TypeError
          ? true
          : e instanceof RangeError
            ? ("yes" as never)
            : e instanceof SyntaxError
              ? (() => {
                  throw new Error("predicate broke");
                })()
              : undefined,
    );
    expect(isExpectedException(new NotFoundException())).toBe(false);
    expect(isExpectedException(new TypeError("x"))).toBe(true);
    expect(isExpectedException(new RangeError("x"))).toBe(false);
    expect(isExpectedException(new SyntaxError("x"))).toBe(false);
    expect(getFailureCounts().get("errors.expected")).toBe(1);
    expect(isExpectedException(new HttpException("bad", 400))).toBe(true);
  });

  it("the first installed app's rule wins until it is uninstalled", () => {
    const first = installErrorTracking(false);
    const second = installErrorTracking(undefined);
    expect(isExpectedException(new NotFoundException())).toBe(false);
    first();
    expect(isExpectedException(new NotFoundException())).toBe(true);
    second();
  });
});

describe("exception events", () => {
  it("attributes follow the SDK (code before name); plain objects get their constructor name", () => {
    const coded = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    expect(exceptionAttributes(coded)).toMatchObject({
      "exception.type": "ECONNREFUSED",
      "exception.message": "refused",
    });
    expect(exceptionAttributes({ status: "error", message: "rpc" })).toEqual({
      "exception.type": "Object",
      "exception.message": "rpc",
    });
    expect(exceptionAttributes("text")).toEqual({
      "exception.message": "text",
    });
  });

  it("a message seen in the trace marks a by-message report propagated (BullMQ's job failed)", () => {
    tracer.startActiveSpan("consumer", (consumer) => {
      tracer.startActiveSpan("process", (process) => {
        recordExceptionEvent(process, new Error("job broke"));
        process.end();
      });
      recordExceptionEvent(consumer, "job broke", { byMessage: true });
      recordExceptionEvent(consumer, "another reason", { byMessage: true });
      consumer.end();
    });
    const events = exceptionEvents("consumer");
    expect(events[0]?.attributes?.["nestrix.exception.propagated"]).toBe(true);
    expect(
      events[1]?.attributes?.["nestrix.exception.propagated"],
    ).toBeUndefined();
  });
});
