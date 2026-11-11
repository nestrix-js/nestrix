// Q4: classes with #private members, classes extending Map / EventEmitter, callable objects in
// fields, generators, accessors, thenables. Built with createApplicationContext (no HTTP adapter),
// which also takes `instrument`.
import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { forwardRef, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { context as otelContext, TraceFlags, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  CallableHolderService,
  EmitterService,
  GeneratorService,
  MapService,
  PrivateService,
  QueryLike,
  ThenableService,
} from "../src/app/fixtures.ts";
import { ruleMarkers } from "../src/rules.ts";
import { setupTracing } from "../src/tracing.ts";
import {
  createInstanceDecorator,
  isWrapper,
  type Strategy,
  type WrapOptions,
} from "../src/wrap.ts";

const exporter = setupTracing();

@Module({
  providers: [
    PrivateService,
    MapService,
    EmitterService,
    CallableHolderService,
    GeneratorService,
    ThenableService,
  ],
})
class AwkwardModule {}

async function context(strategy: Strategy, extra: Partial<WrapOptions> = {}) {
  let internalErrors = 0;
  const instanceDecorator = createInstanceDecorator({
    strategy,
    shouldWrapClass: ruleMarkers,
    onInternalError: () => internalErrors++,
    ...extra,
  });
  const app = await NestFactory.createApplicationContext(AwkwardModule, {
    logger: false,
    abortOnError: false,
    instrument: { instanceDecorator },
  });
  return { app, errors: () => internalErrors };
}

const names = () => exporter.getFinishedSpans().map((s) => s.name);

for (const strategy of ["own", "proto"] as Strategy[]) {
  describe(`Q4 ${strategy}`, () => {
    it("#private fields and methods, and the #x in o brand check", async () => {
      const { app, errors } = await context(strategy);
      try {
        exporter.reset();
        const svc = app.get(PrivateService);
        expect(isWrapper(svc.increment)).toBe(true);
        expect(svc.increment()).toBe(1);
        expect(svc.increment()).toBe(2);
        expect(svc.peek()).toBe(2);
        expect(PrivateService.isBranded(svc)).toBe(true);
        expect(svc instanceof PrivateService).toBe(true);
        expect(
          names().filter((n) => n === "PrivateService.increment"),
        ).toHaveLength(2);
        expect(errors()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("class extending Map: own methods wrapped, Map methods and internal slots intact", async () => {
      const { app, errors } = await context(strategy);
      try {
        exporter.reset();
        const svc = app.get(MapService);
        expect(isWrapper(svc.remember)).toBe(true);
        expect(isWrapper(svc.get)).toBe(false); // the walk stops at the built-in Map.prototype
        expect(svc.remember("a", 1)).toBe(1);
        expect(svc.size).toBe(1);
        expect(Map.prototype.get.call(svc, "a")).toBe(1);
        expect([...svc.entries()]).toEqual([["a", 1]]);
        expect(svc instanceof Map).toBe(true);
        expect(names()).toEqual(["MapService.remember"]);
        expect(errors()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("class extending EventEmitter: behaviour intact; EventEmitter's own JS methods are wrapped unless stopped", async () => {
      for (const stopAt of [
        undefined,
        new Set<object>([EventEmitter.prototype]),
      ]) {
        const { app, errors } = await context(strategy, { stopAt });
        try {
          exporter.reset();
          const svc = app.get(EmitterService);
          const got: string[] = [];
          svc.on("evt", (p: string) => got.push(p));
          expect(svc.fire("x")).toBe(true);
          expect(got).toEqual(["x"]);
          expect(svc.listenerCount("evt")).toBe(1);
          expect(svc instanceof EventEmitter).toBe(true);
          console.log(
            `Q4 ${strategy} EventEmitter stopAt=${stopAt ? "EventEmitter.prototype" : "none"}: spans ${names().join(", ")}`,
          );
          expect(isWrapper(svc.emit)).toBe(!stopAt);
          expect(errors()).toBe(0);
        } finally {
          await app.close();
        }
      }
    });

    it("callable objects and arrow functions held in fields are not wrapped", async () => {
      const { app } = await context(strategy);
      try {
        const svc = app.get(CallableHolderService);
        expect(isWrapper(svc.double)).toBe(false);
        expect(isWrapper(svc.handler)).toBe(false);
        expect(svc.double.tag).toBe("callable");
        expect(svc.double.get("k")).toBe("get:k");
        expect(svc.handler()).toBe("arrow-field");
        expect(svc.useDouble(2)).toBe(9); // 2*2 + "get:k".length
        expect(isWrapper(svc.useDouble)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("generators and accessors are left alone", async () => {
      const { app } = await context(strategy);
      try {
        const svc = app.get(GeneratorService);
        expect(isWrapper(svc.numbers)).toBe(false);
        expect(isWrapper(svc.agen)).toBe(false);
        expect([...svc.numbers()]).toEqual([1, 2]);
        const out: string[] = [];
        for await (const v of svc.agen()) out.push(v);
        expect(out).toEqual(["a"]);
        expect(svc.computed).toBe("computed");
      } finally {
        await app.close();
      }
    });

    it("thenables, rejections and sync throws keep their identity and semantics", async () => {
      const { app } = await context(strategy);
      try {
        exporter.reset();
        const svc = app.get(ThenableService);
        const q = svc.query();
        expect(q).toBeInstanceOf(QueryLike); // not converted into a Promise
        expect(await q.where(2)).toBe(3);
        const p = svc.rejectLater();
        expect(p).toBeInstanceOf(Promise);
        await expect(p).rejects.toThrow("rejected on purpose");
        let caught: unknown;
        try {
          svc.throwSync();
        } catch (e) {
          caught = e;
        }
        expect((caught as Error).message).toBe("thrown on purpose");
        expect((caught as Error).stack).toContain("throwSync");
        const spans = exporter.getFinishedSpans();
        expect(
          spans.find((s) => s.name === "ThenableService.rejectLater")?.status
            .code,
        ).toBe(2);
        expect(
          spans.find((s) => s.name === "ThenableService.throwSync")?.status
            .code,
        ).toBe(2);
      } finally {
        await app.close();
      }
    });

    it("observable differences on the instance", async () => {
      const { app } = await context(strategy);
      try {
        const svc = app.get(PrivateService);
        const raw = new PrivateService();
        expect(Object.keys(svc)).toEqual(Object.keys(raw));
        expect(JSON.stringify(svc)).toBe(JSON.stringify(raw));
        expect(inspect(svc)).toBe(inspect(raw));
        expect(svc.constructor).toBe(PrivateService);
        const ownNames = Object.getOwnPropertyNames(svc);
        const protoIsClassProto =
          Object.getPrototypeOf(svc) === PrivateService.prototype;
        console.log(
          `Q4 ${strategy}: getOwnPropertyNames=${JSON.stringify(ownNames)} getPrototypeOf(i)===Class.prototype: ${protoIsClassProto} structuredClone: ${(() => {
            try {
              structuredClone(svc);
              return "ok";
            } catch (e) {
              return (e as Error).name;
            }
          })()} (unwrapped: ${(() => {
            try {
              structuredClone(raw);
              return "ok";
            } catch (e) {
              return (e as Error).name;
            }
          })()})`,
        );
        if (strategy === "own") {
          expect(ownNames).toContain("increment");
          expect(protoIsClassProto).toBe(true);
        } else {
          expect(ownNames).not.toContain("increment");
          expect(protoIsClassProto).toBe(false);
        }
      } finally {
        await app.close();
      }
    });

    it("decorating the same instance twice wraps once (useExisting passes one instance twice)", () => {
      @Injectable()
      class Twice {
        hit() {
          return 1;
        }
      }
      const decorate = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleMarkers,
      });
      const t = new Twice();
      decorate(t);
      decorate(t);
      // A second, independent decorator (e.g. composeInstrument with another tool) also does not double-wrap.
      createInstanceDecorator({ strategy, shouldWrapClass: ruleMarkers })(t);
      exporter.reset();
      t.hit();
      expect(names()).toEqual(["Twice.hit"]);
    });

    it("frozen instances, class fields shadowing methods, and Proxy instances pass through untouched", () => {
      let internalErrors = 0;
      const decorate = createInstanceDecorator({
        strategy,
        onInternalError: () => internalErrors++,
      });
      class Frozen {
        constructor() {
          Object.freeze(this);
        }
        m() {
          return "m";
        }
      }
      const f = new Frozen();
      expect(decorate(f)).toBe(f);
      expect(isWrapper(f.m)).toBe(false);
      expect(f.m()).toBe("m");

      class Shadow {
        m = () => "field";
        m2() {
          return "proto";
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: test pokes at the prototype
      (Shadow.prototype as any).m = () => "proto-m";
      const s = new Shadow();
      decorate(s);
      expect(s.m()).toBe("field");

      // A Proxy whose getPrototypeOf trap throws (as nestjs-cls proxy providers can outside a request).
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("no context");
          },
        },
      );
      expect(decorate(hostile)).toBe(hostile);
      expect(internalErrors).toBe(1);
    });
  });
}

describe("Q4 promise handling and unhandledRejection (child process; Vitest intercepts unhandled rejections)", () => {
  it("'derived' preserves unhandledRejection; 'side' swallows it", () => {
    const script = fileURLToPath(
      new URL("./fixtures/unhandled.ts", import.meta.url),
    );
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", script],
      {
        // unflagged type stripping only exists from Node 22.18; the flag is accepted on every supported Node
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      },
    );
    const r = JSON.parse(out.trim().split("\n").at(-1) as string);
    console.log(`Q4 unhandledRejection counts: ${JSON.stringify(r)}`);
    expect(r).toEqual({ unwrapped: 1, derived: 1, side: 0 });
  });
});

// forwardRef: Nest injects a placeholder before the class is constructed, then Object.assign()s the real
// instance into it and decorates that same object. The wrapper must reach whoever holds the placeholder.
@Injectable()
class CircA {
  constructor(
    @Inject(forwardRef(() => CircB)) readonly b: { pong(): string },
  ) {}
  ping() {
    return `ping:${this.b.pong()}`;
  }
}
@Injectable()
class CircB {
  constructor(@Inject(forwardRef(() => CircA)) readonly a: CircA) {}
  pong() {
    return "pong";
  }
  viaA() {
    return this.a.ping();
  }
}
@Module({ providers: [CircA, CircB] })
class CircularModule {}

describe("Q4 forwardRef circular providers", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: both sides see wrapped methods`, async () => {
      const instanceDecorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleMarkers,
      });
      const app = await NestFactory.createApplicationContext(CircularModule, {
        logger: false,
        abortOnError: false,
        instrument: { instanceDecorator },
      });
      try {
        exporter.reset();
        const b = app.get(CircB);
        expect(b.viaA()).toBe("ping:pong");
        expect(b.a).toBe(app.get(CircA));
        expect(names()).toEqual(["CircB.pong", "CircA.ping", "CircB.viaA"]);
      } finally {
        await app.close();
      }
    });
  }
});

describe("Q6 fast path under a non-recording parent", () => {
  it("skips span creation only when the active span is not recording", () => {
    @Injectable()
    class Fast {
      m() {
        return 1;
      }
    }
    const fast = createInstanceDecorator({
      strategy: "own",
      skipUnderNonRecordingParent: true,
    })(new Fast()) as Fast;
    const slow = createInstanceDecorator({ strategy: "own" })(
      new Fast(),
    ) as Fast;
    const unsampled = trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    });
    exporter.reset();
    otelContext.with(trace.setSpan(otelContext.active(), unsampled), () => {
      expect(fast.m()).toBe(1);
      expect(slow.m()).toBe(1);
    });
    // The test provider uses the SDK 3 default sampler, ParentBased(AlwaysOn): the slow path also produced
    // only a non-recording span, so the fast path changes nothing observable here, only the cost. Under a
    // sampler that is not parent-based the two would differ.
    expect(names()).toEqual([]);
    exporter.reset();
    expect(fast.m()).toBe(1); // no parent at all: a span is started as usual
    expect(names()).toEqual(["Fast.m"]);
  });
});
