// Rule 1 for level 2: every wrapper, decorator and sink call catches what it could throw itself.
// Each test injects one fault on Nestrix's side (tracer, span, context manager, sink, a hostile
// instance, another instrument) and checks the host sees exactly the unwrapped behaviour.
import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import {
  type Context,
  type ContextManager,
  context,
  ROOT_CONTEXT,
  type Span,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import {
  composeInstrument,
  NestrixInstrument,
} from "../../src/methods/instrument.js";
import {
  configureMethods,
  resetMethodsForTests,
} from "../../src/methods/registry.js";
import { setMethodCallSink } from "../../src/methods/sink.js";
import { isWrapper } from "../../src/methods/wrap.js";

// A context manager whose `with` can fail before or after running the callback.
let cmMode: "ok" | "before" | "after" = "ok";
// A valid active parent span: a method called with none gets no span at all (D-67).
const PARENT: Context = trace.setSpan(
  ROOT_CONTEXT,
  trace.wrapSpanContext({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
  }),
);
let active: Context = PARENT;
const cm: ContextManager = {
  active: () => active,
  with(ctx, fn, thisArg, ...args) {
    if (cmMode === "before") throw new Error("context manager failed before");
    const prev = active;
    active = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      active = prev;
      // biome-ignore lint/correctness/noUnsafeFinally: the fault being injected
      if (cmMode === "after") throw new Error("context manager failed after");
    }
  },
  bind: (_ctx, target) => target,
  enable() {
    return this;
  },
  disable() {
    return this;
  },
};

// A tracer provider whose spans can fail at chosen points; `started` counts startSpan calls.
let fault: "none" | "startSpan" | "end" | "status" | "getTracer" = "none";
let started = 0;
const provider: TracerProvider = {
  getTracer(): Tracer {
    if (fault === "getTracer") throw new Error("getTracer failed");
    return {
      startSpan() {
        if (fault === "startSpan") throw new Error("startSpan failed");
        started++;
        // A non-recording span with a valid, sampled context.
        const span = trace.wrapSpanContext({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: (1000 + started).toString(16).padStart(16, "0"),
          traceFlags: 1,
        });
        const wrapped: Span = Object.create(span);
        wrapped.end = () => {
          if (fault === "end") throw new Error("end failed");
        };
        wrapped.setStatus = (s) => {
          if (fault === "status") throw new Error("setStatus failed");
          return span.setStatus(s);
        };
        wrapped.recordException = (e) => {
          if (fault === "status") throw new Error("recordException failed");
          return span.recordException(e);
        };
        return wrapped;
      },
      startActiveSpan(): never {
        throw new Error("not used by level 2");
      },
    };
  },
};

beforeAll(() => {
  context.setGlobalContextManager(cm);
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  cmMode = "ok";
  fault = "none";
  started = 0;
  resetMethodsForTests();
  resetDiagnosticsForTests();
});

@Injectable()
class Svc {
  calls = 0;
  sync(x: number): number {
    this.calls++;
    return x * 2;
  }
  async later(x: number): Promise<number> {
    this.calls++;
    await Promise.resolve();
    return x + 1;
  }
  throwing(): never {
    this.calls++;
    throw new TypeError("method failure");
  }
  async rejecting(): Promise<never> {
    this.calls++;
    await Promise.resolve();
    throw new RangeError("async failure");
  }
}

function wrapped(): Svc {
  configureMethods(
    { enabled: true, include: [Svc], exclude: [], enhancers: [] },
    [],
  );
  const s = NestrixInstrument.instanceDecorator(new Svc()) as Svc;
  expect(isWrapper(s.sync)).toBe(true);
  return s;
}

async function observe(s: Svc) {
  const out: unknown[] = [];
  out.push(s.sync(2));
  out.push(await s.later(1));
  try {
    s.throwing();
  } catch (e) {
    out.push([(e as Error).constructor.name, (e as Error).message]);
  }
  out.push(
    await s.rejecting().catch((e: Error) => [e.constructor.name, e.message]),
  );
  out.push(s.calls);
  return out;
}

const expected = [
  4,
  2,
  ["TypeError", "method failure"],
  ["RangeError", "async failure"],
  4,
];

describe("faults on Nestrix's side leave the host's calls unchanged", () => {
  for (const f of ["startSpan", "end", "status", "getTracer"] as const) {
    it(`tracer fault: ${f}`, async () => {
      const s = wrapped();
      fault = f;
      expect(await observe(s)).toEqual(expected);
      const counts = [...getFailureCounts().keys()];
      expect(counts.some((k) => k.startsWith("methods."))).toBe(true);
    });
  }

  for (const mode of ["before", "after"] as const) {
    it(`context manager fails ${mode} running the method: the method runs exactly once`, async () => {
      const s = wrapped();
      cmMode = mode;
      expect(await observe(s)).toEqual(expected);
      expect(getFailureCounts().get("methods.context")).toBeGreaterThan(0);
    });
  }

  it("a throwing sink is counted; calls are unchanged", async () => {
    const s = wrapped();
    const dispose = setMethodCallSink({
      record() {
        throw new Error("sink failed");
      },
    });
    try {
      expect(await observe(s)).toEqual(expected);
      expect(getFailureCounts().get("methods.sink")).toBe(4);
    } finally {
      dispose();
    }
  });

  it("a hostile Proxy instance (getPrototypeOf throws) is returned untouched and counted", () => {
    configureMethods(
      { enabled: true, include: [], exclude: [], enhancers: [] },
      [],
    );
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("no context");
        },
      },
    );
    expect(NestrixInstrument.instanceDecorator(hostile)).toBe(hostile);
    expect(getFailureCounts().get("methods.decorate")).toBe(1);
  });

  it("an instance whose defineProperty throws is returned as is (Nest keeps it), counted", () => {
    @Injectable()
    class Pure {
      double(x: number): number {
        return x * 2;
      }
    }
    const p = new Proxy(new Pure(), {
      defineProperty() {
        throw new Error("no defineProperty");
      },
    });
    configureMethods(
      { enabled: true, include: [Pure], exclude: [], enhancers: [] },
      [],
    );
    expect(NestrixInstrument.instanceDecorator(p)).toBe(p);
    expect(p.double(3)).toBe(6);
    expect(getFailureCounts().get("methods.decorate")).toBe(1);
  });

  it("a prototype method replaced by a throwing getter falls back to the method captured at decoration", () => {
    @Injectable()
    class Swapped {
      m(): string {
        return "original";
      }
    }
    configureMethods(
      { enabled: true, include: [Swapped], exclude: [], enhancers: [] },
      [],
    );
    const s = NestrixInstrument.instanceDecorator(new Swapped()) as Swapped;
    Object.defineProperty(Swapped.prototype, "m", {
      get() {
        throw new Error("getter failed");
      },
      configurable: true,
    });
    expect(s.m()).toBe("original");
    expect(getFailureCounts().get("methods.lookup")).toBe(1);
  });

  it("composeInstrument: a throwing instrument passes the instance on unchanged, counted; the others still run", () => {
    const seen: unknown[] = [];
    const composed = composeInstrument(
      {
        instanceDecorator() {
          throw new Error("other tool failed");
        },
      },
      undefined,
      {
        instanceDecorator: (i: unknown) => {
          seen.push(i);
          return i;
        },
      },
    );
    const instance = { a: 1 };
    expect(composed.instanceDecorator(instance)).toBe(instance);
    expect(seen).toEqual([instance]);
    expect(getFailureCounts().get("methods.compose")).toBe(1);
  });

  it("composeInstrument passes each decorator's result to the next, in order", () => {
    const order: string[] = [];
    const replacement = { replaced: true };
    const composed = composeInstrument(
      {
        instanceDecorator: (i: unknown) => {
          order.push("first");
          return i === 1 ? replacement : i;
        },
      },
      {
        instanceDecorator: (i: unknown) => {
          order.push(`second:${i === replacement}`);
          return i;
        },
      },
    );
    expect(composed.instanceDecorator(1)).toBe(replacement);
    expect(order).toEqual(["first", "second:true"]);
  });

  it("an empty include list and a matcher RegExp with the global flag behave", () => {
    const re = /^Svc$/g;
    configureMethods(
      { enabled: true, include: [re], exclude: [], enhancers: [] },
      [],
    );
    const a = NestrixInstrument.instanceDecorator(new Svc()) as Svc;
    expect(isWrapper(a.sync)).toBe(true);
    expect(started).toBe(0);
    a.sync(1);
    a.sync(1);
    expect(started).toBe(2);
  });
});
