import "reflect-metadata";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Span, withSpan } from "../src/span.js";

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

beforeEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
});

const finished = () => exporter.getFinishedSpans();

describe("withSpan", () => {
  it("returns the value of a sync function and ends the span", () => {
    expect(withSpan("sync", () => 42)).toBe(42);
    expect(finished().map((s) => s.name)).toEqual(["sync"]);
    expect(finished()[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(finished()[0]?.instrumentationScope.name).toBe("@nestrix/nestjs");
  });

  it("passes the span to the function and makes it active", () => {
    withSpan("active", (span) => {
      expect(trace.getActiveSpan()).toBe(span);
    });
  });

  it("parents the span to the active span", () => {
    withSpan("outer", () => {
      withSpan("inner", () => undefined);
    });
    const outer = finished().find((s) => s.name === "outer");
    const inner = finished().find((s) => s.name === "inner");
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId);
  });

  it("passes SpanOptions through", () => {
    withSpan("opts", () => undefined, { attributes: { "x.y": 1 } });
    expect(finished()[0]?.attributes["x.y"]).toBe(1);
  });

  it("records a sync throw, sets error status and rethrows the same error", () => {
    const boom = new Error("boom");
    let caught: unknown;
    try {
      withSpan("throws", () => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    const span = finished()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toEqual(["exception"]);
    expect(span?.events[0]?.attributes?.["exception.message"]).toBe("boom");
  });

  it("calls a function that throws synchronously exactly once", () => {
    let calls = 0;
    expect(() =>
      withSpan("once", () => {
        calls++;
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(calls).toBe(1);
  });

  it("rethrows non-Error values unchanged", () => {
    const thrown = { code: 7 };
    try {
      withSpan("obj", () => {
        throw thrown;
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBe(thrown);
    }
    expect(finished()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("keeps the span open until a native promise settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const result = withSpan("async", async () => {
      await gate;
      return "done";
    });
    expect(result).toBeInstanceOf(Promise);
    expect(finished()).toHaveLength(0);
    release();
    await expect(result).resolves.toBe("done");
    expect(finished().map((s) => s.name)).toEqual(["async"]);
    expect(finished()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records a rejection and rejects with the same error", async () => {
    const boom = new Error("rejected");
    const result = withSpan("rejects", async () => {
      throw boom;
    });
    await expect(result).rejects.toBe(boom);
    expect(finished()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(finished()[0]?.events[0]?.name).toBe("exception");
  });

  it("keeps the span active across awaits inside the function", async () => {
    await withSpan("outer", async (outer) => {
      await Promise.resolve();
      expect(trace.getActiveSpan()).toBe(outer);
    });
  });

  it("leaves promise subclasses and other thenables untouched, ending when fn returns", () => {
    class MyPromise<T> extends Promise<T> {}
    const sub = MyPromise.resolve(1);
    expect(withSpan("sub", () => sub)).toBe(sub);
    // biome-ignore lint/suspicious/noThenProperty: a non-native thenable is the case under test
    const thenable = { then: () => undefined };
    expect(withSpan("thenable", () => thenable)).toBe(thenable);
    expect(finished().map((s) => s.name)).toEqual(["sub", "thenable"]);
  });

  it("is no longer active after it returns, sync and async", async () => {
    expect(trace.getActiveSpan()).toBeUndefined();
    withSpan("s", () => undefined);
    expect(trace.getActiveSpan()).toBeUndefined();
    await withSpan("a", async () => {
      await Promise.resolve();
    });
    expect(trace.getActiveSpan()).toBeUndefined();
    withSpan("outer", (outer) => {
      withSpan("inner", () => undefined);
      expect(trace.getActiveSpan()).toBe(outer);
    });
  });

  it("ignores an own throwing `then` on a native promise", async () => {
    const p = Promise.resolve("v");
    // biome-ignore lint/suspicious/noThenProperty: an own `then` on a native promise is the case under test
    Object.defineProperty(p, "then", {
      get() {
        throw new Error("own then");
      },
    });
    const result = withSpan("own-then", () => p);
    await expect(result).resolves.toBe("v");
    expect(finished().map((s) => s.name)).toEqual(["own-then"]);
  });

  it("returns the result unchanged and ends the span when following it fails", () => {
    // Prototype is Promise.prototype, but it is not a real promise: `then` throws on it.
    const fake = Object.setPrototypeOf({}, Promise.prototype);
    expect(withSpan("fake", () => fake)).toBe(fake);
    expect(finished().map((s) => s.name)).toEqual(["fake"]);
  });

  it("does not throw when the span's own bookkeeping fails", () => {
    const result = withSpan("bad-span", (span) => {
      span.end = () => {
        throw new Error("end failed");
      };
      span.recordException = () => {
        throw new Error("record failed");
      };
      return 5;
    });
    expect(result).toBe(5);
    const boom = new Error("user");
    expect(() =>
      withSpan("bad-span-2", (span) => {
        span.end = () => {
          throw new Error("end failed");
        };
        span.recordException = () => {
          throw new Error("record failed");
        };
        throw boom;
      }),
    ).toThrow(boom);
  });
});

describe("@Span", () => {
  class Svc {
    #secret = "s3";
    value = 10;

    @Span()
    sync(a: number, b: number): number {
      return a + b + this.value;
    }

    @Span("custom.name", { attributes: { k: "v" } })
    async asyncNamed(): Promise<string> {
      await Promise.resolve();
      return this.#secret;
    }

    @Span()
    fails(): never {
      throw new RangeError("nope");
    }

    @Span()
    async rejects(): Promise<never> {
      throw new TypeError("later");
    }

    @Span()
    static stat(): string {
      return "static";
    }
  }

  it("names spans Class.method by default and preserves this, args and return", () => {
    expect(new Svc().sync(1, 2)).toBe(13);
    expect(finished().map((s) => s.name)).toEqual(["Svc.sync"]);
  });

  it("supports a custom name, options, #private access and async", async () => {
    await expect(new Svc().asyncNamed()).resolves.toBe("s3");
    const span = finished()[0];
    expect(span?.name).toBe("custom.name");
    expect(span?.attributes.k).toBe("v");
  });

  it("names static methods after the class", () => {
    expect(Svc.stat()).toBe("static");
    expect(finished()[0]?.name).toBe("Svc.stat");
  });

  it("records sync errors and rejections and keeps their identity", async () => {
    const svc = new Svc();
    expect(() => svc.fails()).toThrow(RangeError);
    await expect(svc.rejects()).rejects.toBeInstanceOf(TypeError);
    expect(finished().map((s) => [s.name, s.status.code])).toEqual([
      ["Svc.fails", SpanStatusCode.ERROR],
      ["Svc.rejects", SpanStatusCode.ERROR],
    ]);
  });

  it("parents a decorated call to the active span", () => {
    withSpan("request", () => new Svc().sync(0, 0));
    const request = finished().find((s) => s.name === "request");
    const child = finished().find((s) => s.name === "Svc.sync");
    expect(child?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    );
  });

  describe("function shape", () => {
    const ABOVE = "test:above";
    const BELOW = "test:below";
    const mark =
      (key: string): MethodDecorator =>
      (_t, _k, descriptor) => {
        Reflect.defineMetadata(key, true, descriptor.value as object);
      };

    class Shaped {
      @mark(ABOVE)
      @Span()
      method(_a: string, _b: number): void {}
    }
    class ShapedBelow {
      @Span()
      @mark(BELOW)
      method(_a: string, _b: number): void {}
    }

    it("sees metadata from decorators applied above and below", () => {
      expect(Reflect.getOwnMetadata(ABOVE, Shaped.prototype.method)).toBe(true);
      expect(Reflect.getOwnMetadata(BELOW, ShapedBelow.prototype.method)).toBe(
        true,
      );
    });

    it("copies metadata keys, own properties, name and length", () => {
      const original = function original(
        _a: unknown,
        _b: unknown,
        _c: unknown,
      ) {
        return 1;
      };
      Reflect.defineMetadata("k1", "v1", original);
      Reflect.defineMetadata("k2", { n: 2 }, original);
      Object.defineProperty(original, "extra", {
        value: "own",
        enumerable: false,
        writable: true,
        configurable: true,
      });
      const sym = Symbol("s");
      (original as unknown as Record<symbol, number>)[sym] = 9;
      const descriptor: PropertyDescriptor = { value: original };
      Span("named")({}, "m", descriptor);
      const wrapped = descriptor.value;
      expect(wrapped).not.toBe(original);
      expect(wrapped.name).toBe("original");
      expect(wrapped.length).toBe(3);
      expect(Reflect.getOwnMetadataKeys(wrapped).sort()).toEqual(["k1", "k2"]);
      expect(Reflect.getOwnMetadata("k2", wrapped)).toEqual({ n: 2 });
      expect(Object.getOwnPropertyDescriptor(wrapped, "extra")).toEqual(
        Object.getOwnPropertyDescriptor(original, "extra"),
      );
      expect(wrapped[sym]).toBe(9);
    });

    it("makes a wrapper that is not constructible and has no prototype", () => {
      expect(Object.hasOwn(Shaped.prototype.method, "prototype")).toBe(false);
      expect(
        () => new (Shaped.prototype.method as unknown as new () => unknown)(),
      ).toThrow(TypeError);
    });

    it("keeps the length of the decorated method", () => {
      expect(Shaped.prototype.method.length).toBe(2);
      expect(Shaped.prototype.method.name).toBe("method");
    });

    it("leaves a non-function descriptor alone", () => {
      const descriptor: PropertyDescriptor = {
        get: () => 1,
        configurable: true,
      };
      expect(Span()({}, "g", descriptor)).toBe(descriptor);
      expect(descriptor.value).toBeUndefined();
    });
  });
});
