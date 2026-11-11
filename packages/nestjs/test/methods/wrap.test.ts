// Unit tests of the level 2 wrapper (architecture §4.3), without Nest: copy of the function's
// shape, promise handling, the SAMPLED fast path, call-time lookup, idempotence, disabled plans,
// the sink, and the cost of a disabled wrapper.
import "reflect-metadata";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Injectable, SetMetadata, UseGuards } from "@nestjs/common";
import { context, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeInstrument,
  NestrixInstrument,
} from "../../src/methods/instrument.js";
import {
  configureMethods,
  methodsEnabled,
  planOf,
  resetMethodsForTests,
} from "../../src/methods/registry.js";
import type { ResolvedMethods } from "../../src/methods/resolved.js";
import { isWrapper } from "../../src/methods/wrap.js";
import {
  methodSpans,
  recordingSink,
  resetSpans,
  setupTracing,
  spanNames,
  spans,
} from "./helpers.js";

setupTracing();
const decorate = <T>(i: T): T => NestrixInstrument.instanceDecorator(i) as T;
const on = (include: unknown[], extra: Partial<ResolvedMethods> = {}) =>
  configureMethods(
    {
      enabled: true,
      include: include as never,
      exclude: [],
      enhancers: [],
      ...extra,
    },
    [],
  );

afterEach(() => {
  resetSpans();
  resetMethodsForTests();
  vi.restoreAllMocks();
});

class AllowGuard {}

describe("shape of the wrapper", () => {
  it("copies every reflect-metadata key, own properties, name and length", () => {
    class Ctl {
      @UseGuards(AllowGuard)
      @SetMetadata("role", "admin")
      handler(_a: number, _b: number): string {
        return "h";
      }
    }
    (Ctl.prototype.handler as unknown as { extra: string }).extra = "own";
    on([Ctl]);
    const c = decorate(new Ctl());
    const original = Ctl.prototype.handler;
    expect(isWrapper(c.handler)).toBe(true);
    expect(Reflect.getOwnMetadataKeys(c.handler).sort()).toEqual(
      Reflect.getOwnMetadataKeys(original).sort(),
    );
    expect(Reflect.getMetadata("role", c.handler)).toBe("admin");
    expect(Reflect.getMetadata("__guards__", c.handler)).toEqual([AllowGuard]);
    expect(c.handler.name).toBe("handler");
    expect(c.handler.length).toBe(2);
    expect((c.handler as unknown as { extra: string }).extra).toBe("own");
    expect(Object.hasOwn(c.handler, "prototype")).toBe(false);
    expect(() => new (c.handler as unknown as new () => unknown)()).toThrow(
      TypeError,
    );
    // The prototype is untouched; the wrapper is a non-enumerable own property.
    expect(Ctl.prototype.handler).toBe(original);
    expect(Object.getOwnPropertyDescriptor(c, "handler")).toMatchObject({
      enumerable: false,
      writable: true,
      configurable: true,
    });
  });

  it("is idempotent: the same instance twice, or through a second composed instrument, wraps once", () => {
    @Injectable()
    class Twice {
      hit(): number {
        return 1;
      }
    }
    on([Twice]);
    const t = new Twice();
    decorate(t);
    const first = (t as unknown as { hit: unknown }).hit;
    decorate(t);
    composeInstrument(NestrixInstrument, NestrixInstrument).instanceDecorator(
      t,
    );
    expect((t as unknown as { hit: unknown }).hit).toBe(first);
    t.hit();
    expect(spanNames()).toEqual(["Twice.hit"]);
  });

  it("wrappers are cached per class: two instances share the same wrapper functions", () => {
    @Injectable()
    class Shared {
      m(): number {
        return 1;
      }
    }
    on([Shared]);
    const a = decorate(new Shared());
    const b = decorate(new Shared());
    expect(a.m).toBe(b.m);
  });

  it("functions, primitives, plain objects and null pass through untouched", () => {
    on([]);
    const fn = (a: number, b: number, c: number) => a + b + c;
    const obj = { a: 1 };
    for (const v of [fn, obj, null, undefined, 42, "s", Symbol.for("x")]) {
      expect(decorate(v)).toBe(v);
    }
    expect(Object.getOwnPropertyNames(obj)).toEqual(["a"]);
    expect(fn.length).toBe(3);
  });

  it("an unmarked class is not wrapped unless included", () => {
    class Plain {
      m(): number {
        return 1;
      }
    }
    on([]);
    const p = decorate(new Plain());
    expect(Object.getOwnPropertyNames(p)).toEqual([]);
    on([Plain]);
    const q = decorate(new Plain());
    expect(isWrapper(q.m)).toBe(true);
  });
});

describe("calls", () => {
  @Injectable()
  class Svc {
    sync(x: number): number {
      return x * 2;
    }
    async later(x: number): Promise<number> {
      await new Promise((r) => setTimeout(r, 10));
      return x + 1;
    }
    throwing(): never {
      throw new TypeError("sync failure");
    }
    async rejecting(): Promise<never> {
      await Promise.resolve();
      throw new RangeError("async failure");
    }
    thrownString(): never {
      throw "a plain string";
    }
  }

  it("sync and async results reach the caller; the async span covers the awaited work", async () => {
    on([Svc]);
    const s = decorate(new Svc());
    expect(s.sync(2)).toBe(4);
    expect(await s.later(1)).toBe(2);
    const later = methodSpans().find((x) => x.name === "Svc.later");
    const ms =
      (later?.duration[0] ?? 0) * 1e3 + (later?.duration[1] ?? 0) / 1e6;
    expect(ms).toBeGreaterThanOrEqual(5);
  });

  it("the same error object is rethrown, recorded as an exception event with error status", async () => {
    on([Svc]);
    const s = decorate(new Svc());
    let caught: unknown;
    try {
      s.throwing();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).stack).toContain("throwing");
    const rejected = await s.rejecting().catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(RangeError);
    expect(() => s.thrownString()).toThrow("a plain string");
    for (const [name, message] of [
      ["Svc.throwing", "sync failure"],
      ["Svc.rejecting", "async failure"],
      ["Svc.thrownString", "a plain string"],
    ] as const) {
      const span = methodSpans().find((x) => x.name === name);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.events[0]?.name).toBe("exception");
      expect(span?.events[0]?.attributes?.["exception.message"]).toBe(message);
    }
  });

  it("calls the method the prototype holds at call time (a spy after decoration applies)", () => {
    @Injectable()
    class Spied {
      get1(): string {
        return "real";
      }
    }
    on([Spied]);
    const s = decorate(new Spied());
    const spy = vi.spyOn(Spied.prototype, "get1").mockReturnValue("mocked");
    expect(s.get1()).toBe("mocked");
    expect(spanNames()).toEqual(["Spied.get1"]);
    spy.mockRestore();
    expect(s.get1()).toBe("real");
  });

  it("a disabled plan calls straight through and reports nothing; switching it on traces the same instance", () => {
    on([]);
    @Injectable()
    class Late {
      m(): number {
        return 7;
      }
    }
    // Decorated before any config: wrappers installed, plan off.
    resetMethodsForTests();
    const l = decorate(new Late());
    expect(isWrapper(l.m)).toBe(true);
    const { calls, dispose } = recordingSink();
    try {
      expect(l.m()).toBe(7);
      expect(spanNames()).toEqual([]);
      expect(calls).toEqual([]);
      on([Late]);
      expect(planOf(Late)?.on).toBe(true);
      expect(l.m()).toBe(7);
      expect(spanNames()).toEqual(["Late.m"]);
      expect(calls.map((c) => c.method)).toEqual(["m"]);
    } finally {
      dispose();
    }
  });

  it("the configuration's disposer switches every plan off", () => {
    @Injectable()
    class Off {
      m(): number {
        return 1;
      }
    }
    const dispose = on([Off]);
    const o = decorate(new Off());
    dispose();
    o.m();
    expect(spanNames()).toEqual([]);
  });
});

describe("the SAMPLED fast path", () => {
  const ctxWith = (flags: number) =>
    trace.setSpan(
      context.active(),
      trace.wrapSpanContext({
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: flags,
      }),
    );

  it("skips the span under an unsampled parent, but still reports the call", async () => {
    @Injectable()
    class Fast {
      m(): number {
        return 1;
      }
      async a(): Promise<number> {
        await new Promise((r) => setTimeout(r, 10));
        return 2;
      }
    }
    on([Fast]);
    const f = decorate(new Fast());
    const { calls, dispose } = recordingSink();
    try {
      const results = await context.with(ctxWith(TraceFlags.NONE), async () => [
        f.m(),
        await f.a(),
      ]);
      expect(results).toEqual([1, 2]);
      expect(spanNames()).toEqual([]);
      expect(calls.map((c) => c.method)).toEqual(["m", "a"]);
      // The async call's duration follows the promise even with no span.
      expect(calls[1]?.durationMs).toBeGreaterThanOrEqual(5);
      context.with(ctxWith(TraceFlags.SAMPLED), () => f.m());
      expect(spanNames()).toEqual(["Fast.m"]);
    } finally {
      dispose();
    }
  });

  it("a fire-and-forget call after a sampled request span ended keeps its span", async () => {
    @Injectable()
    class Mailer {
      send(): string {
        return "sent";
      }
    }
    on([Mailer]);
    const m = decorate(new Mailer());
    let bg: Promise<string> | undefined;
    trace.getTracer("t").startActiveSpan("GET /orders", (req) => {
      bg = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        return m.send();
      })();
      req.end();
    });
    await bg;
    expect(spanNames()).toEqual(["GET /orders", "Mailer.send"]);
    const send = methodSpans()[0];
    const req = spans().find((s) => s.name === "GET /orders");
    expect(send?.parentSpanContext?.spanId).toBe(req?.spanContext().spanId);
  });

  it("without the sink, an unsampled call returns the method's own promise object", async () => {
    @Injectable()
    class Memo {
      #p = Promise.resolve(1);
      get(): Promise<number> {
        return this.#p;
      }
    }
    on([Memo]);
    const m = decorate(new Memo());
    context.with(ctxWith(TraceFlags.NONE), () => {
      expect(m.get()).toBe(m.get());
    });
    // Traced (sampled), a plain native promise is followed: a new promise each call (§4.3).
    expect(m.get()).not.toBe(m.get());
  });
});

describe("unhandled rejections (child process)", () => {
  it("an ignored rejected promise is still reported as unhandled, exactly once", async () => {
    const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
    const child = fileURLToPath(
      new URL("./fixtures/unhandled-child.mjs", import.meta.url),
    );
    const strip = (process.features as { typescript?: unknown }).typescript
      ? []
      : ["--experimental-strip-types"];
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...strip, "--no-warnings", "--import", `${fixtures}ts-hooks.mjs`, child],
      { timeout: 20_000 },
    );
    const counts = JSON.parse(stdout.trim().split("\n").at(-1) as string);
    expect(counts).toEqual({ unwrapped: 1, wrapped: 1 });
  });
});

describe("methodsEnabled()", () => {
  it("is false before any decoration, true after one under an enabled config, false when disabled", () => {
    resetMethodsForTests();
    on([]);
    expect(methodsEnabled()).toBe(false);
    decorate({});
    expect(methodsEnabled()).toBe(true);
    on([], { enabled: false });
    expect(methodsEnabled()).toBe(false);
  });
});

describe("cost of a disabled wrapper (measured, not asserted)", () => {
  it("prints ns per call: raw, disabled wrapper, enabled wrapper unsampled", () => {
    @Injectable()
    class Cost {
      m(x: number): number {
        return x + 1;
      }
    }
    const raw = new Cost();
    resetMethodsForTests();
    const disabled = decorate(new Cost());
    const N = 1_000_000;
    const time = (f: () => void) => {
      for (let i = 0; i < 100_000; i++) f();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) f();
      return Number(process.hrtime.bigint() - t0) / N;
    };
    let acc = 0;
    const rawNs = time(() => {
      acc += raw.m(acc & 1);
    });
    const offNs = time(() => {
      acc += disabled.m(acc & 1);
    });
    on([Cost]);
    const unsampled = trace.setSpan(
      context.active(),
      trace.wrapSpanContext({
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.NONE,
      }),
    );
    const fastNs = context.with(unsampled, () =>
      time(() => {
        acc += disabled.m(acc & 1);
      }),
    );
    // Recorded on Apple M1 Pro, Node 26.13, Vitest, 2026-11-11, three runs: raw 3.8 ns, disabled
    // 32.1-32.6 ns, enabled under an unsampled parent (fast path, no sink) 68.7-69.7 ns per call.
    // Benchmarks are deferred (delivery mode); this only shows the order of magnitude.
    console.log(
      `disabled-wrapper cost: raw ${rawNs.toFixed(1)} ns, disabled ${offNs.toFixed(1)} ns, fast path ${fastNs.toFixed(1)} ns per call`,
    );
    expect(acc).toBeGreaterThan(0);
  });
});
