// Rule 1: every wrapper and hook body catches what it could throw itself. Each test injects one fault
// into Nestrix's side and checks the host sees exactly the unwrapped behaviour.
import "reflect-metadata";
import { Controller, Get, Injectable, Module, UseGuards } from "@nestjs/common";
import {
  type Context,
  type ContextManager,
  context,
  ROOT_CONTEXT,
  type Span,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule, DenyGuard, UsersService } from "../src/app/fixtures.ts";
import { ADAPTERS, boot } from "../src/boot.ts";
import { ruleMarkers } from "../src/rules.ts";
import {
  createInstanceDecorator,
  isWrapper,
  makeWrapper,
  type Strategy,
  type WrapOptions,
} from "../src/wrap.ts";

// A context manager whose `with` can be told to fail before or after running the callback.
let cmMode: "ok" | "before" | "after" = "ok";
let active: Context = ROOT_CONTEXT;
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
context.setGlobalContextManager(cm);

function faultyTracer(
  fault: "startSpan" | "end" | "setStatus" | "none",
  calls: { started: number },
): () => Tracer {
  const real = trace.getTracer("faults"); // no provider registered: non-recording spans
  return () => ({
    startSpan(name, options, ctx) {
      if (fault === "startSpan") throw new Error("startSpan failed");
      calls.started++;
      const span = real.startSpan(name, options, ctx);
      const wrapped: Span = Object.create(span);
      wrapped.end = () => {
        if (fault === "end") throw new Error("end failed");
      };
      wrapped.setStatus = (s) => {
        if (fault === "setStatus") throw new Error("setStatus failed");
        return span.setStatus(s);
      };
      return wrapped;
    },
    startActiveSpan: real.startActiveSpan.bind(
      real,
    ) as Tracer["startActiveSpan"],
  });
}

afterEach(() => {
  cmMode = "ok";
});

describe("wrapper faults", () => {
  const sync = function value(this: { k: number }, a: number) {
    return this.k + a;
  };
  const asyncOk = async function value(a: number) {
    await Promise.resolve();
    return a;
  };
  const err = new Error("host error");
  const asyncFail = async () => {
    await Promise.resolve();
    throw err;
  };
  const syncFail = () => {
    throw err;
  };

  for (const fault of ["startSpan", "end", "setStatus"] as const) {
    it(`${fault} throws: results, receivers and errors are unchanged, and the fault is reported`, async () => {
      const calls = { started: 0 };
      const reported: string[] = [];
      const opts: WrapOptions = {
        strategy: "own",
        tracer: faultyTracer(fault, calls),
        onInternalError: (where) => reported.push(where),
      };
      expect(makeWrapper(sync, "s", opts).call({ k: 1 }, 2)).toBe(3);
      expect(await makeWrapper(asyncOk, "a", opts)(5)).toBe(5);
      expect(() => makeWrapper(syncFail, "f", opts)()).toThrow(err);
      await expect(makeWrapper(asyncFail, "af", opts)()).rejects.toBe(err);
      expect(reported.length).toBeGreaterThan(0);
    });
  }

  it("context manager throws before running the method: the method runs once, untraced", () => {
    let runs = 0;
    const fn = () => ++runs;
    cmMode = "before";
    const reported: string[] = [];
    expect(
      makeWrapper(fn, "x", {
        strategy: "own",
        onInternalError: (w) => reported.push(w),
      })(),
    ).toBe(1);
    expect(runs).toBe(1);
    expect(reported).toContain("context.with");
  });

  it("context manager throws after running the method: the method ran once and its result is returned", () => {
    let runs = 0;
    const fn = () => ++runs;
    cmMode = "after";
    expect(makeWrapper(fn, "x", { strategy: "own" })()).toBe(1);
    expect(runs).toBe(1);
  });

  it("context manager throws after the method threw: the host's error wins", () => {
    cmMode = "after";
    expect(() => makeWrapper(syncFail, "x", { strategy: "own" })()).toThrow(
      err,
    );
  });

  it("the error reporter itself throws: still no effect on the host", async () => {
    const opts: WrapOptions = {
      strategy: "own",
      tracer: faultyTracer("startSpan", { started: 0 }),
      onInternalError: () => {
        throw new Error("reporter failed");
      },
    };
    expect(makeWrapper(sync, "s", opts).call({ k: 1 }, 1)).toBe(2);
  });

  it("a promise whose then() throws is returned as is", async () => {
    const p = Promise.resolve(7);
    // biome-ignore lint/suspicious/noThenProperty: the fault being injected
    Object.defineProperty(p, "then", {
      value: () => {
        throw new Error("then failed");
      },
    });
    const reported: string[] = [];
    const out = makeWrapper(() => p, "x", {
      strategy: "own",
      onInternalError: (w) => reported.push(w),
    })();
    expect(out).toBe(p);
    expect(reported).toContain("promise.then");
  });
});

describe("decorator faults", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: shouldWrapClass throws: the instance comes back untouched`, () => {
      @Injectable()
      class A {
        m() {
          return 1;
        }
      }
      const reported: string[] = [];
      const decorate = createInstanceDecorator({
        strategy,
        shouldWrapClass: () => {
          throw new Error("rule failed");
        },
        onInternalError: (w) => reported.push(w),
      });
      const a = new A();
      expect(decorate(a)).toBe(a);
      expect(isWrapper(a.m)).toBe(false);
      expect(Object.getPrototypeOf(a)).toBe(A.prototype);
      expect(reported).toEqual(["instanceDecorator"]);
    });

    it(`${strategy}: metadata copy fails for one method: that method stays unwrapped, so its guard still applies`, async () => {
      const original = Reflect.defineMetadata;
      let failures = 0;
      const reported: string[] = [];
      Reflect.defineMetadata = function (
        this: unknown,
        key: unknown,
        value: unknown,
        target: unknown,
        prop?: unknown,
      ) {
        if (isWrapper(target) && key === "__guards__") {
          failures++;
          throw new Error("defineMetadata failed");
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwarding
        return (original as any).call(Reflect, key, value, target, prop);
      } as typeof Reflect.defineMetadata;
      try {
        const decorator = createInstanceDecorator({
          strategy,
          shouldWrapClass: ruleMarkers,
          onInternalError: (w) => reported.push(w),
        });
        for (const adapter of ADAPTERS) {
          const b = await boot(adapter, AppModule, {
            instanceDecorator: decorator,
          });
          try {
            const g = await b.get("/users/guarded");
            // Never fails open. With "proto" on Express the unwrapped method's route also moves behind
            // `/users/:id` (registration order changes), so it answers 400 from ParseIntPipe instead:
            // see "Q2 route order" in q2-q3-metadata.test.ts.
            expect(g.status).not.toBe(200);
            if (strategy === "own" || adapter !== "express")
              expect(g.status).toBe(403);
            expect((await b.get("/rs/guarded")).status).toBe(403);
            expect((await b.get("/users/code")).status).toBe(202); // other methods still wrapped and correct
          } finally {
            await b.close();
          }
        }
      } finally {
        Reflect.defineMetadata = original;
      }
      expect(failures).toBeGreaterThan(0);
      expect(
        reported.some((r) => r.startsWith("wrap UsersController.guarded")),
      ).toBe(true);
    });

    it(`${strategy}: a rule that throws for one class under a real app: app boots and serves`, async () => {
      const decorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: (info) => {
          if (info.ctor === UsersService) throw new Error("rule failed");
          return ruleMarkers(info);
        },
      });
      const b = await boot("express", AppModule, {
        instanceDecorator: decorator,
      });
      try {
        expect((await b.get("/users/1")).status).toBe(200);
        expect((await b.get("/users/guarded")).status).toBe(403);
      } finally {
        await b.close();
      }
    });
  }

  it("Nest's own safety net: a decorator that throws is logged and the raw instance used", async () => {
    @Controller("x")
    class X {
      @Get()
      @UseGuards(DenyGuard)
      x() {
        return 1;
      }
    }
    @Module({ controllers: [X], providers: [DenyGuard] })
    class M {}
    const b = await boot("express", M, {
      instanceDecorator: () => {
        throw new Error("raw decorator failure");
      },
    });
    try {
      expect((await b.get("/x")).status).toBe(403);
    } finally {
      await b.close();
    }
  });
});
